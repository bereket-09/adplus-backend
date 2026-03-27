const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const WatchLink = require('../models/watchLink.model');
const AuditLog = require('../models/audit.model');
const logger = require('../utils/logger');
const Reward = require('../models/reward.model');
const Blacklist = require('../models/blacklist.model');
const cache = require('../utils/internalCache');
const AdEngine = require('../utils/adEngine');
const MarketerTransaction = require('../models/marketerTransaction.model');

const safeAgg = async (model, pipeline) => {
    try {
        return await model.aggregate(pipeline);
    } catch (err) {
        logger.error(`Aggregation Failed on ${model.modelName}: ${err.message}`);
        return [];
    }
};

exports.getAdminDashboardAnalytics = async (req, res, next) => {
    try {
        logger.info('Fetching admin dashboard analytics');
        const cacheKey = 'analytics:admin_dashboard';
        const cached = cache.get(cacheKey);
        if (cached) return res.json(cached);

        const [
            totalMarketers,
            activeMarketers,
            activeCampaigns,
            totalBlacklisted,
            totalViews,
            completedViews
        ] = await Promise.all([
            Marketer.countDocuments().catch(() => 0),
            Marketer.countDocuments({ status: 'active' }).catch(() => 0),
            Ad.countDocuments({ status: 'active' }).catch(() => 0),
            Blacklist.countDocuments({ is_active: true }).catch(() => 0),
            WatchLink.countDocuments().catch(() => 0),
            WatchLink.countDocuments({ status: 'completed' }).catch(() => 0)
        ]);

        const engagementRate = totalViews === 0 ? 0 : Math.round((completedViews / totalViews) * 100);

        const revenueAgg = await safeAgg(WatchLink, [
            { $match: { status: 'completed' } },
            { $lookup: { from: 'ads', localField: 'ad_id', foreignField: '_id', as: 'ad' } },
            { $unwind: '$ad' },
            { $group: { _id: null, total: { $sum: '$ad.cost_per_view' } } }
        ]);
        const totalRevenue = Math.round((revenueAgg[0]?.total || 0) * 100) / 100;

        const monthlyTrendsAgg = await safeAgg(WatchLink, [
            {
                $group: {
                    _id: { $dateToString: { format: "%b", date: "$created_at" } },
                    views: { $sum: 1 }
                }
            },
            { $sort: { "_id": 1 } }
        ]);
        const trends = monthlyTrendsAgg.map(t => ({ name: t._id, views: t.views }));

        const rateTierAgg = await safeAgg(Ad, [
            { $group: { _id: "$rate_tier", count: { $sum: 1 } } }
        ]);
        const totalAdsCount = rateTierAgg.reduce((acc, cur) => acc + cur.count, 0);
        const rateDistribution = rateTierAgg.map(r => ({
            name: (r._id && typeof r._id === 'string') ? r._id.charAt(0).toUpperCase() + r._id.slice(1) : "Unknown",
            value: totalAdsCount > 0 ? Math.round((r.count / totalAdsCount) * 100) : 0
        }));

        const topCampaignsAgg = await safeAgg(WatchLink, [
            { $match: { status: 'completed' } },
            { $group: { _id: "$ad_id", views: { $sum: 1 } } },
            { $sort: { views: -1 } },
            { $limit: 6 }
        ]);

        const topAdIds = topCampaignsAgg.map(t => t._id);
        const topAds = await Ad.find({ _id: { $in: topAdIds } }).populate('marketer_id', 'name').lean();

        const topCampaigns = topCampaignsAgg.map(t => {
            const ad = topAds.find(a => a._id.toString() === t._id.toString());
            return {
                name: ad?.campaign_name || 'Campaign ' + t._id.toString().substring(0, 6),
                marketer: ad?.marketer_id?.name || 'Partner',
                views: t.views,
                revenue: Math.round((ad?.cost_per_view || 0.5) * t.views * 10) / 10
            };
        });

        const budgetAgg = await safeAgg(Ad, [
            { $group: { _id: null, total: { $sum: "$budget_allocation" }, avgCpv: { $avg: "$cost_per_view" } } }
        ]);

        const response = {
            status: true,
            platform: {
                views: totalViews,
                active_marketers: activeMarketers,
                active_campaigns: activeCampaigns,
                total_revenue: totalRevenue,
                engagement_rate: engagementRate,
                system_health: 99.9,
                avg_latency_sec: 0.4,
                uptime_hours: 720,
                total_budget: Math.round(budgetAgg[0]?.total || 0),
                avg_cpv: Math.round((budgetAgg[0]?.avgCpv || 0) * 100) / 100,
                total_campaigns: await Ad.countDocuments().catch(() => 0)
            },
            trends: { monthly_views: trends.length > 0 ? trends : [{ name: "Jan", views: 0 }] },
            rate_distribution: rateDistribution.length > 0 ? rateDistribution : [{ name: "Standard", value: 100 }],
            top_campaigns: topCampaigns
        };

        cache.set(cacheKey, response, 60_000);
        res.json(response);
    } catch (err) {
        next(err);
    }
};

exports.getAdminAnalysis = async (req, res, next) => {
    try {
        const [totalViews, completedViews, totalAds, totalMarketers] = await Promise.all([
            WatchLink.countDocuments().catch(() => 0),
            WatchLink.countDocuments({ status: 'completed' }).catch(() => 0),
            Ad.countDocuments().catch(() => 0),
            Marketer.countDocuments().catch(() => 0)
        ]);

        const completionRate = totalViews === 0 ? 0 : Math.round((completedViews / totalViews) * 100);

        // Traffic Trend (Last 7 Days)
        const trendsAgg = await WatchLink.aggregate([
            {
                $group: {
                    _id: { $dateToString: { format: "%Y-%m-%d", date: "$created_at" } },
                    views: { $sum: 1 },
                    completions: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } }
                }
            },
            { $sort: { "_id": 1 } },
            { $limit: 7 }
        ]);

        const trends = trendsAgg.map(t => ({
            name: t._id,
            views: t.views,
            completions: t.completions
        }));

        // Funnel Logic
        const funnel = [
            { label: "Total Tokens Generated", value: totalViews },
            { label: "Video Started", value: await WatchLink.countDocuments({ status: 'started' }) + completedViews },
            { label: "Completions", value: completedViews },
            { label: "Rewards Verified", value: await Reward.countDocuments() }
        ];

        // Marketer Performance Agg
        const marketerPerformanceAgg = await WatchLink.aggregate([
            { $group: { 
                _id: "$marketer_id", 
                views: { $sum: 1 }, 
                completions: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } } 
            } },
            { $lookup: { from: 'marketers', localField: '_id', foreignField: '_id', as: 'marketer' } },
            { $unwind: '$marketer' },
            { $lookup: { from: 'ads', localField: '_id', foreignField: 'marketer_id', as: 'ads' } },
            { $project: { 
                name: "$marketer.name", 
                views: 1, 
                campaigns: { $size: "$ads" },
                spend: { $multiply: ["$completions", 1.5] }, // Placeholder CPV logic
                efficiency: { $cond: [{ $eq: ["$views", 0] }, 0, { $multiply: [{ $divide: ["$completions", "$views"] }, 100] }] } 
            } },
            { $sort: { views: -1 } },
            { $limit: 10 }
        ]);

        res.json({
            status: true,
            platform: {
                total_views: totalViews,
                daily_active_users: totalViews / 30 || 0, // mock daily active from total views average
                completion_rate: completionRate,
                total_revenue: totalAds * 100, // Placeholder revenue logic
                avg_latency: 24,
                system_uptime: 99.99
            },
            trends: trends.length > 0 ? trends : [
                 { name: "Mar 20", views: 450, completions: 380 },
                 { name: "Mar 21", views: 520, completions: 450 },
            ],
            funnel,
            marketer_performance: marketerPerformanceAgg.map(m => ({
                name: m.name,
                views: m.views,
                campaigns: m.campaigns,
                spend: m.spend,
                efficiency: Math.round(m.efficiency)
            }))
        });
    } catch (err) {
        next(err);
    }
};

exports.getAdminFraudAnalytics = async (req, res, next) => {
    try {
        const [totalBlocked, suspiciousLinks] = await Promise.all([
            Blacklist.countDocuments().catch(() => 0),
            WatchLink.find({ fraud_flags: { $not: { $size: 0 } } })
                .sort({ created_at: -1 })
                .limit(10)
                .populate('ad_id', 'title')
                .populate('marketer_id', 'name')
                .lean()
        ]);

        const recentBlocked = await Blacklist.find({})
            .sort({ blacklisted_at: -1 })
            .limit(10)
            .lean();

        res.json({
            status: true,
            kpis: {
                blocked_attempts: totalBlocked,
                suspicious_activities: suspiciousLinks.length,
                fraud_detection_rate: 0.5 // mock for now
            },
            suspicious_activity: suspiciousLinks.map(l => ({
                id: l._id,
                type: l.fraud_flags.join(", "),
                ip: l.ip || "Unknown",
                location: l.location?.category || "Unknown",
                timestamp: l.created_at,
                confidence: 90
            })),
            blocked_ips: recentBlocked.map(b => ({
                ip: b.ip,
                reason: b.reason || "System Blocked",
                blockedAt: b.blacklisted_at ? b.blacklisted_at.toISOString().split('T')[0] : "—",
                duration: "Permanent"
            }))
        });
    } catch (err) {
        next(err);
    }
};

exports.getAdminBudgetAnalytics = async (req, res, next) => {
    try {
        const [totalRevenueAgg, totalTopupsAgg, platformBalanceAgg] = await Promise.all([
            MarketerTransaction.aggregate([{ $match: { type: 'deduction' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
            MarketerTransaction.aggregate([{ $match: { type: 'topup' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]),
            Marketer.aggregate([{ $group: { _id: null, total: { $sum: "$remaining_budget" } } }])
        ]);

        const recentTransactions = await MarketerTransaction.find({})
            .sort({ created_at: -1 })
            .limit(20)
            .populate('marketer_id', 'name')
            .lean();

        res.json({
            status: true,
            kpis: {
                total_revenue: totalRevenueAgg[0]?.total || 0,
                total_topups: totalTopupsAgg[0]?.total || 0,
                platform_balance: platformBalanceAgg[0]?.total || 0
            },
            recent_transactions: recentTransactions.map(t => ({
                id: t._id,
                marketer: t.marketer_id?.name || 'Unknown Partner',
                amount: t.amount,
                type: t.type,
                reason: t.reason || t.description,
                timestamp: t.created_at
            }))
        });
    } catch (err) {
        next(err);
    }
};
