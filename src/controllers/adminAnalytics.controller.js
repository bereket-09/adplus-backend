const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const WatchLink = require('../models/watchLink.model');
const AuditLog = require('../models/audit.model');
const logger = require('../utils/logger');
const Reward = require('../models/reward.model');

exports.getAdminDashboardAnalytics = async (req, res, next) => {
    try {
        logger.info('Fetching admin dashboard analytics');

        /* =============================
           BASIC COUNTS
        ============================== */

        const [
            totalMarketers,
            activeMarketers,
            activeCampaigns
        ] = await Promise.all([
            Marketer.countDocuments(),
            Marketer.countDocuments({ status: 'active' }),
            Ad.countDocuments({ status: 'active' })
        ]);

        /* =============================
           PLATFORM VIEWS & ENGAGEMENT
        ============================== */

        const totalViews = await WatchLink.countDocuments();
        const completedViews = await WatchLink.countDocuments({ status: 'completed' });

        const engagementRate =
            totalViews === 0 ? 0 : Math.round((completedViews / totalViews) * 1000) / 10;

        /* =============================
           TOTAL REVENUE
        ============================== */

        const completedSessions = await WatchLink.find(
            { status: 'completed' },
            { ad_id: 1 }
        ).lean();

        const adIds = completedSessions.map(w => w.ad_id);

        const ads = await Ad.find(
            { _id: { $in: adIds } },
            { _id: 1, cost_per_view: 1 }
        ).lean();

        const adCostMap = {};
        ads.forEach(ad => {
            adCostMap[ad._id.toString()] = ad.cost_per_view || 0;
        });

        let totalRevenue = 0;
        completedSessions.forEach(w => {
            totalRevenue += adCostMap[w.ad_id.toString()] || 0;
        });

        totalRevenue = Math.round(totalRevenue * 100) / 100;

        /* =============================
           GLOBAL VIEW TRENDS (6 MONTHS)
        ============================== */

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
        sixMonthsAgo.setDate(1);

        const monthlyViews = await WatchLink.aggregate([
            { $match: { created_at: { $gte: sixMonthsAgo } } },
            {
                $group: {
                    _id: {
                        year: { $year: "$created_at" },
                        month: { $month: "$created_at" }
                    },
                    views: { $sum: 1 }
                }
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } }
        ]);

        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

        const viewsTrend = monthlyViews.map(m => ({
            name: monthNames[m._id.month - 1],
            views: m.views
        }));

        /* =============================
           RATE DISTRIBUTION
        ============================== */

        const rateDistributionRaw = await Ad.aggregate([
            {
                $project: {
                    tier: {
                        $cond: [
                            { $lte: ["$cost_per_view", 0] },
                            "Free",
                            {
                                $cond: [
                                    { $lte: ["$cost_per_view", 1] },
                                    "Standard",
                                    "Premium"
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: "$tier",
                    count: { $sum: 1 }
                }
            }
        ]);

        const totalAds = rateDistributionRaw.reduce((s, r) => s + r.count, 0) || 1;

        const rateDistribution = rateDistributionRaw.map(r => ({
            name: r._id,
            value: Math.round((r.count / totalAds) * 100)
        }));

        /* =============================
           TOP PERFORMING CAMPAIGNS
        ============================== */

        const topCampaignsAgg = await WatchLink.aggregate([
            { $match: { status: 'completed' } },
            {
                $group: {
                    _id: "$ad_id",
                    views: { $sum: 1 }
                }
            },
            { $sort: { views: -1 } },
            { $limit: 5 }
        ]);

        const topAdIds = topCampaignsAgg.map(t => t._id);

        const topAds = await Ad.find(
            { _id: { $in: topAdIds } },
            { campaign_name: 1, marketer_id: 1, cost_per_view: 1 }
        ).populate('marketer_id', 'name').lean();

        const topCampaigns = topCampaignsAgg.map(t => {
            const ad = topAds.find(a => a._id.toString() === t._id.toString());
            const revenue = (ad?.cost_per_view || 0) * t.views;

            return {
                name: ad?.campaign_name || 'Unknown Campaign',
                marketer: ad?.marketer_id?.name || 'Unknown Marketer',
                views: t.views,
                revenue: Math.round(revenue * 100) / 100
            };
        });

        /* =============================
           RESPONSE
        ============================== */

        res.json({
            status: true,
            platform: {
                views: totalViews,
                active_marketers: activeMarketers,
                active_campaigns: activeCampaigns,
                total_revenue: totalRevenue,
                engagement_rate: engagementRate,
                system_health: 99.9
            },
            trends: {
                monthly_views: viewsTrend
            },
            rate_distribution: rateDistribution,
            top_campaigns: topCampaigns
        });

    } catch (err) {
        logger.error(`AdminAnalytics.getAdminDashboardAnalytics - ${err.message}`);
        next(err);
    }
};


exports.getAdminAnalysis = async (req, res, next) => {
    try {
        logger.info('Fetching full admin platform analytics');

        /* =============================
           PLATFORM LEVEL METRICS
        ============================== */

        const [
            totalMarketers,
            activeMarketers,
            activeCampaigns,
            totalViews,
            completedViews,
            dailyActiveUsers
        ] = await Promise.all([
            Marketer.countDocuments(),
            Marketer.countDocuments({ status: 'active' }),
            Ad.countDocuments({ status: 'active' }),
            WatchLink.countDocuments(),
            WatchLink.countDocuments({ status: 'completed' }),
            WatchLink.distinct('msisdn', { created_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }) // last 24h
        ]);

        const completionRate = totalViews === 0 ? 0 : Math.round((completedViews / totalViews) * 1000) / 10;

        /* =============================
           TOTAL REVENUE
        ============================== */
        const completedLinks = await WatchLink.find({ status: 'completed' }, { ad_id: 1 }).lean();
        const adIds = completedLinks.map(w => w.ad_id);
        const ads = await Ad.find({ _id: { $in: adIds } }, { cost_per_view: 1 }).lean();

        const adCostMap = {};
        ads.forEach(ad => adCostMap[ad._id.toString()] = ad.cost_per_view || 0);

        let totalRevenue = 0;
        completedLinks.forEach(w => totalRevenue += adCostMap[w.ad_id.toString()] || 0);
        totalRevenue = Math.round(totalRevenue * 100) / 100;

        /* =============================
           PLATFORM TREND (MONTHLY LAST 6 MONTHS)
        ============================== */
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
        sixMonthsAgo.setDate(1);

        const monthlyViewsAgg = await WatchLink.aggregate([
            { $match: { created_at: { $gte: sixMonthsAgo } } },
            {
                $group: {
                    _id: { year: { $year: "$created_at" }, month: { $month: "$created_at" } },
                    views: { $sum: 1 },
                    completions: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } }
                }
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } }
        ]);

        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const platformTrend = monthlyViewsAgg.map(m => ({
            name: monthNames[m._id.month - 1],
            views: m.views,
            completions: m.completions
        }));

        /* =============================
           REGIONAL DISTRIBUTION (by WatchLink location if exists)
        ============================== */
        const regionAgg = await WatchLink.aggregate([
            { $match: { "location.region": { $exists: true } } },
            { $group: { _id: "$location.region", count: { $sum: 1 } } }
        ]);
        const totalRegionCount = regionAgg.reduce((s, r) => s + r.count, 0) || 1;
        const regionalDistribution = regionAgg.map(r => ({
            name: r._id,
            value: Math.round((r.count / totalRegionCount) * 100)
        }));

        /* =============================
           FUNNEL METRICS
        ============================== */
        const totalSMS = await AuditLog.countDocuments({ type: 'sms_sent' });
        const totalLinksClicked = await WatchLink.countDocuments({ status: { $in: ['opened', 'started', 'completed'] } });
        const videosStarted = await WatchLink.countDocuments({ status: { $in: ['started', 'completed'] } });
        const videosCompleted = await WatchLink.countDocuments({ status: 'completed' });
        const rewardsIssued = await Reward.countDocuments({ status: 'granted' });

        const funnel = [
            { label: "Total SMS Sent", value: totalSMS },
            { label: "Links Clicked", value: totalLinksClicked },
            { label: "Videos Started", value: videosStarted },
            { label: "Videos Completed", value: videosCompleted },
            { label: "Rewards Issued", value: rewardsIssued }
        ];

        /* =============================
           MARKETER PERFORMANCE
        ============================== */
        const marketers = await Marketer.find({}, { name: 1 }).lean();
        const marketerPerformance = await Promise.all(marketers.map(async (m) => {
            const campaigns = await Ad.countDocuments({ marketer_id: m._id });
            const views = await WatchLink.countDocuments({ marketer_id: m._id });
            const spendAgg = await Ad.aggregate([
                { $match: { marketer_id: m._id } },
                { $group: { _id: null, totalSpend: { $sum: "$budget_allocation" } } }
            ]);
            const spend = spendAgg[0]?.totalSpend || 0;
            const efficiency = views === 0 || spend === 0 ? 0 : Math.round((views / spend) * 100);
            return {
                name: m.name,
                campaigns,
                views,
                spend,
                efficiency
            };
        }));

        /* =============================
           RESPONSE
        ============================== */
        res.json({
            status: true,
            platform: {
                total_views: totalViews,
                daily_active_users: dailyActiveUsers.length,
                completion_rate: completionRate,
                total_revenue: totalRevenue,
                avg_latency: 92,  // static placeholder
                system_uptime: 99.9 // static
            },
            trends: platformTrend,
            regional_distribution: regionalDistribution,
            funnel,
            marketer_performance: marketerPerformance
        });

    } catch (err) {
        logger.error(`AdminAnalytics.getAdminAnalysis - ${err.message}`);
        next(err);
    }
};


exports.getAdminFraudAnalytics = async (req, res, next) => {
    try {
        logger.info('Fetching admin fraud analytics');

        const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

        /* =============================
           KPI METRICS (FIXED)
        ============================== */

        const [
            totalEvaluated,
            totalFraud,
            totalBlocked
        ] = await Promise.all([
            AuditLog.countDocuments(),                     // all evaluated activity
            AuditLog.countDocuments({ fraud_detected: true }),
            AuditLog.countDocuments({ fraud_detected: true, action: 'blocked' })
        ]);

        const fraudDetectionRate = totalEvaluated === 0
            ? 0
            : Math.round((totalFraud / totalEvaluated) * 1000) / 10;

        const falsePositiveRate = 0.8; // placeholder

        /* =============================
           FRAUD TREND (LAST 14 DAYS)
        ============================== */

        const trendAgg = await AuditLog.aggregate([
            { $match: { timestamp: { $gte: since14d } } },
            {
                $group: {
                    _id: {
                        day: { $dayOfMonth: "$timestamp" },
                        month: { $month: "$timestamp" }
                    },
                    suspicious: {
                        $sum: { $cond: ["$fraud_detected", 1, 0] }
                    },
                    legitimate: {
                        $sum: { $cond: ["$fraud_detected", 0, 1] }
                    }
                }
            },
            { $sort: { "_id.month": 1, "_id.day": 1 } }
        ]);

        const fraudTrend = trendAgg.map(t => ({
            date: `${t._id.month}/${t._id.day}`,
            legitimate: t.legitimate,
            suspicious: t.suspicious,
            blocked: t.suspicious
        }));

        /* =============================
           FRAUD TYPE DISTRIBUTION (FIXED)
        ============================== */

        const fraudTypeAgg = await AuditLog.aggregate([
            { $match: { fraud_detected: true } },
            {
                $group: {
                    _id: "$type",
                    count: { $sum: 1 }
                }
            }
        ]);

        const totalFraudEvents =
            fraudTypeAgg.reduce((s, f) => s + f.count, 0) || 1;

        const fraudTypes = fraudTypeAgg.map(f => ({
            name: f._id || 'unknown',
            value: Math.round((f.count / totalFraudEvents) * 100)
        }));

        /* =============================
           SUSPICIOUS ACTIVITY LOG
        ============================== */

        const suspiciousActivity = await AuditLog.find(
            { fraud_detected: true },
            {
                msisdn: 1,
                type: 1,
                timestamp: 1,
                ad_id: 1
            }
        )
            .sort({ timestamp: -1 })
            .limit(50)
            .lean();

        const adIds = suspiciousActivity.map(a => a.ad_id);
        const ads = await Ad.find(
            { _id: { $in: adIds } },
            { campaign_name: 1 }
        ).lean();

        const adMap = {};
        ads.forEach(a => (adMap[a._id.toString()] = a.campaign_name));

        const suspiciousList = suspiciousActivity.map((a, i) => ({
            id: i + 1,
            msisdn: a.msisdn,
            type: a.type || 'unknown',
            confidence: 80,
            timestamp: a.timestamp,
            campaign: adMap[a.ad_id?.toString()] || 'N/A',
            status: 'blocked'
        }));

        /* =============================
           BLOCKED IP SUMMARY
        ============================== */

        const blockedIPsAgg = await AuditLog.aggregate([
            { $match: { fraud_detected: true, ip: { $exists: true } } },
            {
                $group: {
                    _id: "$ip",
                    attempts: { $sum: 1 },
                    lastSeen: { $max: "$timestamp" }
                }
            },
            { $sort: { attempts: -1 } },
            { $limit: 20 }
        ]);

        const blockedIPs = blockedIPsAgg.map(ip => ({
            ip: ip._id,
            country: 'Unknown',
            reason: 'Suspicious Activity',
            blockedAt: ip.lastSeen,
            attempts: ip.attempts
        }));

        /* =============================
           RESPONSE (UNCHANGED STRUCTURE)
        ============================== */

        res.json({
            status: true,
            kpis: {
                fraud_detection_rate: fraudDetectionRate,
                suspicious_activities: totalFraud,
                blocked_attempts: totalBlocked,
                false_positive_rate: falsePositiveRate
            },
            fraud_trend: fraudTrend,
            fraud_types: fraudTypes,
            suspicious_activity: suspiciousList,
            blocked_ips: blockedIPs
        });

    } catch (err) {
        logger.error(`FraudAnalytics.getAdminFraudAnalytics - ${err.message}`);
        next(err);
    }
};
