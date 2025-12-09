const AuditLog = require('../models/audit.model');
const WatchLink = require('../models/watchLink.model');
const Ad = require('../models/ad.model');
const Marketer = require('../models/marketer.model');
const Reward = require('../models/reward.model');
const logger = require('../utils/logger'); // <-- import logger

exports.getAudits = async (req, res, next) => {
    try {
        const { msisdn, ad_id, marketer_id, type, limit = 100 } = req.query;
        logger.info(`AnalyticsController.getAudits - Fetching audits | msisdn: ${msisdn}, ad_id: ${ad_id}, marketer_id: ${marketer_id}, type: ${type}, limit: ${limit}`);

        const query = {};
        if (msisdn) query.msisdn = msisdn;
        if (ad_id) query.ad_id = ad_id;
        if (marketer_id) query.marketer_id = marketer_id;
        if (type) query.type = type;

        const audits = await AuditLog.find(query).sort({ timestamp: -1 }).limit(parseInt(limit));
        logger.info(`AnalyticsController.getAudits - Found ${audits.length} audit logs`);
        res.json({ status: true, audits });
    } catch (err) {
        logger.error(`AnalyticsController.getAudits - Error: ${err.message}`);
        next(err);
    }
};

exports.getWatchLinks = async (req, res, next) => {
    try {
        const { msisdn, status, ad_id, marketer_id, limit = 100 } = req.query;
        logger.info(`AnalyticsController.getWatchLinks - Fetching watch links | msisdn: ${msisdn}, status: ${status}, ad_id: ${ad_id}, marketer_id: ${marketer_id}, limit: ${limit}`);

        const query = {};
        if (msisdn) query.msisdn = msisdn;
        if (status) query.status = status;
        if (ad_id) query.ad_id = ad_id;
        if (marketer_id) query.marketer_id = marketer_id;

        const links = await WatchLink.find(query).sort({ created_at: -1 }).limit(parseInt(limit));
        logger.info(`AnalyticsController.getWatchLinks - Found ${links.length} watch links`);
        res.json({ status: true, watch_links: links });
    } catch (err) {
        logger.error(`AnalyticsController.getWatchLinks - Error: ${err.message}`);
        next(err);
    }
};

exports.getAdsAnalytics = async (req, res, next) => {
    try {
        logger.info(`AnalyticsController.getAdsAnalytics - Fetching ads analytics`);

        const ads = await Ad.aggregate([
            { $lookup: { from: 'watchlinks', localField: '_id', foreignField: 'ad_id', as: 'views' } },
            {
                $addFields: {
                    total_views: { $size: '$views' },
                    completed_views: { $size: { $filter: { input: '$views', as: 'v', cond: { $eq: ['$$v.status', 'completed'] } } } },
                    completion_rate: { $cond: [{ $eq: [{ $size: '$views' }, 0] }, 0, { $divide: [{ $size: { $filter: { input: '$views', as: 'v', cond: { $eq: ['$$v.status', 'completed'] } } } }, { $size: '$views' }] }] }
                }
            },
            { $project: { views: 0 } }
        ]);
        logger.info(`AnalyticsController.getAdsAnalytics - Aggregated ${ads.length} ads`);
        res.json({ status: true, ads });
    } catch (err) {
        logger.error(`AnalyticsController.getAdsAnalytics - Error: ${err.message}`);
        next(err);
    }
};

exports.getMarketersAnalytics = async (req, res, next) => {
    try {
        logger.info(`AnalyticsController.getMarketersAnalytics - Fetching marketers analytics`);

        const marketers = await Marketer.aggregate([
            { $lookup: { from: 'ads', localField: '_id', foreignField: 'marketer_id', as: 'ads' } },
            {
                $addFields: {
                    total_ads: { $size: '$ads' },
                    total_remaining_budget: { $sum: '$ads.remaining_budget' },
                    total_cost_per_view: { $sum: '$ads.cost_per_view' }
                }
            },
            { $project: { ads: 0 } }
        ]);
        logger.info(`AnalyticsController.getMarketersAnalytics - Aggregated ${marketers.length} marketers`);
        res.json({ status: true, marketers });
    } catch (err) {
        logger.error(`AnalyticsController.getMarketersAnalytics - Error: ${err.message}`);
        next(err);
    }
};

exports.getSingleAdDetail = async (req, res, next) => {
    try {
        const { adId } = req.params;
        logger.info(`AnalyticsController.getSingleAdDetail - Fetching details for ad: ${adId}`);

        const watchSessions = await WatchLink.find({ ad_id: adId });
        const ad = await Ad.findById(adId);

        if (!ad) {
            return res.status(404).json({ status: false, message: "Ad not found" });
        }

        const marketer = await Marketer.findById(ad.marketer_id);

        const costPerView = ad.cost_per_view || 0;
        const budgetAllocation = ad.budget_allocation || 0;

        // --------------------------------------------------------------------
        // SMS SENT COUNT (ACCURATE FROM AUDIT LOGS)
        // --------------------------------------------------------------------
        const smsCount = await AuditLog.countDocuments({
            ad_id: adId,
            type: 'sms_sent'
        });

        // --------------------------------------------------------------------
        // BASIC COUNTS
        // --------------------------------------------------------------------
        const totalViews = watchSessions.length;
        const completedViews = watchSessions.filter(w => w.status === 'completed').length;
        const startedViews = watchSessions.filter(w => ['started', 'completed'].includes(w.status)).length;
        const openedViews = watchSessions.filter(w => ['opened', 'started', 'completed'].includes(w.status)).length;
        const pendingViews = watchSessions.filter(w => w.status === 'pending').length;

        const completionRate = totalViews === 0 ? 0 : completedViews / totalViews;

        // --------------------------------------------------------------------
        // SPEND CALCULATION
        // --------------------------------------------------------------------
        const spent = completedViews * costPerView;
        const remainingBudget = Math.max(budgetAllocation - spent, 0);
        const usagePercent = budgetAllocation > 0 ? (spent / budgetAllocation) * 100 : 0;

        // --------------------------------------------------------------------
        // DAILY SPREAD
        // --------------------------------------------------------------------
        const dailyMap = {};
        for (const w of watchSessions) {
            const d = new Date(w.created_at).toISOString().slice(0, 10);

            if (!dailyMap[d]) {
                dailyMap[d] = { date: d, views: 0, completions: 0, spend: 0 };
            }

            dailyMap[d].views++;

            if (w.status === 'completed') {
                dailyMap[d].completions++;
                dailyMap[d].spend += costPerView;
            }
        }
        const dailyData = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

        // --------------------------------------------------------------------
        // FUNNEL DATA (FULLY FIXED)
        // --------------------------------------------------------------------
        const funnelData = [
            { label: "SMS Sent", value: smsCount },
            { label: "Link Clicked", value: openedViews },
            { label: "Video Started", value: startedViews },
            { label: "Video Completed", value: completedViews }
        ];

        // --------------------------------------------------------------------
        // HEATMAP (DAY x HOUR)
        // --------------------------------------------------------------------
        const heatmapAcc = {};
        for (const w of watchSessions) {
            const dt = new Date(w.created_at);
            const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
            const hour = dt.getHours();
            const key = `${day}-${hour}`;

            if (!heatmapAcc[key]) heatmapAcc[key] = { day, hour, value: 0 };
            heatmapAcc[key].value++;
        }
        const heatmapData = Object.values(heatmapAcc);

        // --------------------------------------------------------------------
        // DEVICE TYPE DISTRIBUTION (from meta_json.deviceInfo)
        // --------------------------------------------------------------------
        const deviceCounters = { Mobile: 0, Tablet: 0, Desktop: 0 };

        for (const w of watchSessions) {
            const category = w.meta_json?.deviceInfo?.category || "Mobile";
            if (deviceCounters[category] !== undefined) deviceCounters[category]++;
        }

        const totalDevices = Object.values(deviceCounters).reduce((a, b) => a + b, 0) || 1;

        // Include only devices with value > 0
        const deviceData = Object.entries(deviceCounters)
            .map(([name, count]) => ({
                name,
                value: Math.round((count / totalDevices) * 100)
            }))
            .filter(device => device.value > 0);


        // --------------------------------------------------------------------
        // HOURLY VOLUME
        // --------------------------------------------------------------------
        const hourlyMap = {};
        for (let h = 0; h < 24; h++) {
            hourlyMap[h] = { hour: `${h.toString().padStart(2, "0")}:00`, views: 0 };
        }

        for (const w of watchSessions) {
            const hour = new Date(w.created_at).getHours();
            hourlyMap[hour].views++;
        }

        const hourlyData = Object.values(hourlyMap);

        // --------------------------------------------------------------------
        // FINAL RESPONSE (UI-CONFORMING)
        // --------------------------------------------------------------------
        res.json({
            status: true,
            ad_id: adId,
            adInfo: ad,
            marketerInfo: marketer,
            // Direct session info
            total_views: totalViews,
            opened_views: openedViews,
            completed_views: completedViews,
            pending_views: pendingViews,
            completion_rate: completionRate,
            watch_sessions: watchSessions,

            // Budget block for UI
            budget: {
                spent,
                remaining_budget: remainingBudget,
                budget_allocation: budgetAllocation,
                usage_percent: usagePercent
            },

            // Full analytic blocks
            analytics: {
                sms_sent: smsCount,
                dailyData,
                funnelData,
                heatmapData,
                deviceData,
                hourlyData
            }
        });

    } catch (err) {
        logger.error(`AnalyticsController.getSingleAdDetail - Error: ${err.message}`);
        next(err);
    }
};


exports.getMarketerAnalytics = async (req, res, next) => {
    try {
        const { marketerId } = req.params;
        logger.info(`Fetching analytics for marketer: ${marketerId}`);

        const marketer = await Marketer.findById(marketerId);
        if (!marketer) {
            return res.status(404).json({ status: false, message: "Marketer not found" });
        }

        const ads = await Ad.find({ marketer_id: marketerId });
        if (!ads.length) {
            return res.status(200).json({ status: true, message: "No ads for this marketer", adCount: 0 });
        }

        const adIds = ads.map(a => a._id);

        // Fetch all watch sessions for all ads
        const watchSessions = await WatchLink.find({ ad_id: { $in: adIds } });

        // --------------------------------------------------------------------
        // SMS sent count
        // --------------------------------------------------------------------
        const smsCount = await AuditLog.countDocuments({
            ad_id: { $in: adIds },
            type: 'sms_sent'
        });

        // --------------------------------------------------------------------
        // Aggregated counts
        // --------------------------------------------------------------------
        const totalViews = watchSessions.length;
        const completedViews = watchSessions.filter(w => w.status === 'completed').length;
        const startedViews = watchSessions.filter(w => ['started', 'completed'].includes(w.status)).length;
        const openedViews = watchSessions.filter(w => ['opened', 'started', 'completed'].includes(w.status)).length;
        const pendingViews = watchSessions.filter(w => w.status === 'pending').length;
        const completionRate = totalViews === 0 ? 0 : completedViews / totalViews;

        // --------------------------------------------------------------------
        // Spend & budget info (sum across all ads)
        // --------------------------------------------------------------------
        const totalBudget = ads.reduce((sum, ad) => sum + (ad.budget_allocation || 0), 0);
        const spent = watchSessions.reduce((sum, w) => {
            const ad = ads.find(a => a._id.toString() === w.ad_id.toString());
            return sum + (w.status === 'completed' ? (ad?.cost_per_view || 0) : 0);
        }, 0);
        const remainingBudget = Math.max(totalBudget - spent, 0);
        const usagePercent = totalBudget > 0 ? (spent / totalBudget) * 100 : 0;

        // --------------------------------------------------------------------
        // Daily spread
        // --------------------------------------------------------------------
        const dailyMap = {};
        for (const w of watchSessions) {
            const date = new Date(w.created_at).toISOString().slice(0, 10);
            if (!dailyMap[date]) dailyMap[date] = { date, views: 0, completions: 0, spend: 0 };
            dailyMap[date].views++;
            if (w.status === 'completed') {
                const ad = ads.find(a => a._id.toString() === w.ad_id.toString());
                dailyMap[date].completions++;
                dailyMap[date].spend += ad?.cost_per_view || 0;
            }
        }
        const dailyData = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

        // --------------------------------------------------------------------
        // Funnel data
        // --------------------------------------------------------------------
        const funnelData = [
            { label: "SMS Sent", value: smsCount },
            { label: "Link Clicked", value: openedViews },
            { label: "Video Started", value: startedViews },
            { label: "Video Completed", value: completedViews }
        ];

        // --------------------------------------------------------------------
        // Heatmap (day x hour)
        // --------------------------------------------------------------------
        const heatmapAcc = {};
        for (const w of watchSessions) {
            const dt = new Date(w.created_at);
            const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
            const hour = dt.getHours();
            const key = `${day}-${hour}`;
            if (!heatmapAcc[key]) heatmapAcc[key] = { day, hour, value: 0 };
            heatmapAcc[key].value++;
        }
        const heatmapData = Object.values(heatmapAcc);

        // --------------------------------------------------------------------
        // Device type distribution
        // --------------------------------------------------------------------
        const deviceCounters = { Mobile: 0, Tablet: 0, Desktop: 0 };
        for (const w of watchSessions) {
            const category = w.meta_json?.deviceInfo?.category || "Mobile";
            if (deviceCounters[category] !== undefined) deviceCounters[category]++;
        }
        const totalDevices = Object.values(deviceCounters).reduce((a, b) => a + b, 0) || 1;
        const deviceData = Object.entries(deviceCounters)
            .map(([name, count]) => ({ name, value: Math.round((count / totalDevices) * 100) }))
            .filter(d => d.value > 0);

        // --------------------------------------------------------------------
        // Hourly data
        // --------------------------------------------------------------------
        const hourlyMap = Array.from({ length: 24 }, (_, h) => ({ hour: `${h.toString().padStart(2, "0")}:00`, views: 0, completions: 0 }));
        for (const w of watchSessions) {
            const hour = new Date(w.created_at).getHours();
            hourlyMap[hour].views++;
            if (w.status === 'completed') hourlyMap[hour].completions++;
        }

        // --------------------------------------------------------------------
        // Response
        // --------------------------------------------------------------------
        res.json({
            status: true,
            marketerId,
            marketerInfo: marketer,
            adCount: ads.length,
            total_views: totalViews,
            opened_views: openedViews,
            completed_views: completedViews,
            pending_views: pendingViews,
            completion_rate: completionRate,
            budget: {
                spent,
                remaining_budget: remainingBudget,
                total_budget: totalBudget,
                usage_percent: usagePercent
            },
            analytics: {
                sms_sent: smsCount,
                dailyData,
                funnelData,
                heatmapData,
                deviceData,
                hourlyData: hourlyMap
            }
        });
    } catch (err) {
        logger.error(`AnalyticsController.getMarketerAnalytics - Error: ${err.message}`);
        next(err);
    }
};


exports.getAdUsers = async (req, res, next) => {
    try {
        const { adId } = req.params;
        logger.info(`AnalyticsController.getAdUsers - Fetching users for ad: ${adId}`);

        const watchSessions = await WatchLink.find({ ad_id: adId }).select('msisdn status opened_at started_at completed_at meta_json');
        const users = watchSessions.map(w => ({
            msisdn: w.msisdn,
            status: w.status,
            opened_at: w.opened_at,
            started_at: w.started_at,
            completed_at: w.completed_at,
            device_info: w.meta_json?.deviceInfo,
            ip: w.meta_json?.ip,
            location: w.meta_json?.location
        }));

        logger.info(`AnalyticsController.getAdUsers - Found ${users.length} users`);
        res.json({ status: true, ad_id: adId, users });
    } catch (err) {
        logger.error(`AnalyticsController.getAdUsers - Error: ${err.message}`);
        next(err);
    }
};

exports.getUserAnalytics = async (req, res, next) => {
    try {
        const { msisdn } = req.params;
        logger.info(`AnalyticsController.getUserAnalytics - Fetching analytics for msisdn: ${msisdn}`);

        const watchSessions = await WatchLink.find({ msisdn });
        const audits = await AuditLog.find({ msisdn });

        const adsWatched = watchSessions.map(w => ({
            ad_id: w.ad_id,
            status: w.status,
            completed_at: w.completed_at,
            reward_granted: w.status === 'completed'
        }));
        const totalRewarded = adsWatched.filter(a => a.reward_granted).length;

        logger.info(`AnalyticsController.getUserAnalytics - total ads watched: ${watchSessions.length}, total rewarded: ${totalRewarded}`);
        res.json({
            status: true,
            msisdn,
            total_ads_watched: watchSessions.length,
            total_rewards: totalRewarded,
            ads: adsWatched,
            audit_logs: audits
        });
    } catch (err) {
        logger.error(`AnalyticsController.getUserAnalytics - Error: ${err.message}`);
        next(err);
    }
};

exports.getRewardsAnalytics = async (req, res, next) => {
    try {
        const { msisdn, ad_id, marketer_id, status, start_date, end_date, limit = 100 } = req.query;
        logger.info(`AnalyticsController.getRewardsAnalytics - Fetching rewards | msisdn: ${msisdn}, ad_id: ${ad_id}, marketer_id: ${marketer_id}, status: ${status}, limit: ${limit}`);

        const query = {};
        if (msisdn) query.msisdn = msisdn;
        if (ad_id) query.ad_id = ad_id;
        if (status) query.status = status;

        if (marketer_id) {
            const watchLinks = await WatchLink.find({ marketer_id }).select('_id');
            query.ad_id = { $in: watchLinks.map(w => w.ad_id) };
        }

        if (start_date || end_date) {
            query.granted_at = {};
            if (start_date) query.granted_at.$gte = new Date(start_date);
            if (end_date) query.granted_at.$lte = new Date(end_date);
        }

        const rewards = await Reward.find(query)
            .sort({ granted_at: -1 })
            .limit(parseInt(limit))
            .populate('ad_id', 'title campaign_name marketer_id');

        const totalRewards = rewards.length;
        const grantedCount = rewards.filter(r => r.status === 'granted').length;
        const pendingCount = rewards.filter(r => r.status === 'pending').length;
        const failedCount = rewards.filter(r => r.status === 'failed').length;

        logger.info(`AnalyticsController.getRewardsAnalytics - totalRewards: ${totalRewards}, granted: ${grantedCount}, pending: ${pendingCount}, failed: ${failedCount}`);
        res.json({
            status: true,
            total_rewards: totalRewards,
            granted: grantedCount,
            pending: pendingCount,
            failed: failedCount,
            rewards
        });
    } catch (err) {
        logger.error(`AnalyticsController.getRewardsAnalytics - Error: ${err.message}`);
        next(err);
    }
};
