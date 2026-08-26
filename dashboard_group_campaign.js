(function(root){
  'use strict';

  const MAX_CAMPAIGN_TARGET = 100;
  const MAX_BATCH_SIZE = 10;
  const DEFAULT_BATCH_SIZE = 10;
  const DEFAULT_JOBS_PER_DAY = 1;
  const DEFAULT_SPACING_HOURS = 4;

  function cleanString(value){ return String(value || '').replace(/\s+/g, ' ').trim(); }
  function identityKey(identity){ return identity?.key || identity?.id || identity?.url || ''; }
  function safeInteger(value, fallback){
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  function isSchedulableCandidate(candidate){
    const status = cleanString(candidate?.status || 'candidate').toLowerCase();
    if (status !== 'safe') return false;
    return !!(candidate?.group_url || candidate?.url || candidate?.search_url || candidate?.facebook_search_url);
  }
  function candidateToJoinTarget(candidate, identity){
    const key = identityKey(identity);
    if (!cleanString(identity?.name)) throw new Error('Missing identity name for group join campaign');
    if (!key) throw new Error('Missing identity key for group join campaign');
    return {
      identity_name: identity.name,
      identity_key: key,
      identity_type: identity.type || candidate?.identity_type || null,
      identity_url: identity.url || candidate?.identity_url || null,
      group_name: candidate?.group_name || candidate?.title || candidate?.query || null,
      group_url: candidate?.group_url || candidate?.url || null,
      search_url: candidate?.search_url || candidate?.facebook_search_url || null,
      facebook_search_url: candidate?.facebook_search_url || candidate?.search_url || null,
      candidate_id: candidate?.id || null,
      join_source: 'dashboard_group_join_campaign'
    };
  }
  function scheduledDateForBatch(startAt, batchIndex, jobsPerDay, spacingHours){
    const start = startAt instanceof Date ? new Date(startAt.getTime()) : new Date(startAt || Date.now());
    if (!Number.isFinite(start.getTime())) throw new Error('Invalid campaign start time');
    const perDay = Math.max(1, safeInteger(jobsPerDay, DEFAULT_JOBS_PER_DAY));
    const dayOffset = Math.floor(batchIndex / perDay);
    const slotInDay = batchIndex % perDay;
    const scheduled = new Date(start.getTime());
    scheduled.setDate(scheduled.getDate() + dayOffset);
    scheduled.setHours(scheduled.getHours() + slotInDay * Math.max(1, safeInteger(spacingHours, DEFAULT_SPACING_HOURS)));
    return scheduled;
  }
  function buildGroupJoinCampaignJobs(options){
    const opts = options || {};
    const userId = cleanString(opts.userId || opts.user_id);
    const identity = opts.identity || {};
    const key = identityKey(identity);
    if (!userId) throw new Error('Missing user id for group join campaign');
    if (!cleanString(identity.name)) throw new Error('Missing identity name for group join campaign');
    if (!key) throw new Error('Missing identity key for group join campaign');

    const requestedBatchSize = safeInteger(opts.batchSize, DEFAULT_BATCH_SIZE);
    if (requestedBatchSize < 1) throw new Error('Invalid batch size for group join campaign');
    const batchSize = Math.min(MAX_BATCH_SIZE, requestedBatchSize);

    const requestedTotal = safeInteger(opts.totalTarget, MAX_CAMPAIGN_TARGET);
    if (requestedTotal < 1) throw new Error('Invalid total target for group join campaign');
    if (requestedTotal > MAX_CAMPAIGN_TARGET) throw new Error(`Group join campaign target cannot exceed ${MAX_CAMPAIGN_TARGET}`);

    const candidates = Array.isArray(opts.candidates) ? opts.candidates : [];
    const targets = candidates
      .filter(isSchedulableCandidate)
      .slice(0, requestedTotal)
      .map(c => candidateToJoinTarget(c, identity));
    if (!targets.length) throw new Error('No safe candidates with Facebook URLs are available for scheduling');

    const jobs = [];
    for (let i = 0; i < targets.length; i += batchSize) {
      const batch = targets.slice(i, i + batchSize);
      const batchIndex = jobs.length;
      const scheduled = scheduledDateForBatch(opts.startAt, batchIndex, opts.jobsPerDay, opts.spacingHours);
      jobs.push({
        user_id: userId,
        message: '__join_groups__',
        delay: 0,
        ai_enabled: false,
        ai_prompt: identity.name,
        groups: batch,
        status: 'pending',
        scheduled_for: scheduled.toISOString(),
        result: {
          text: `Scheduled group join campaign ${batchIndex + 1}/${Math.ceil(targets.length / batchSize)} for ${identity.name}: ${batch.length} group${batch.length === 1 ? '' : 's'}.`,
          join_campaign: true,
          campaign_name: opts.campaignName || `${identity.name} group join campaign`,
          identity_name: identity.name,
          identity_key: key,
          batch_index: batchIndex + 1,
          batch_count: Math.ceil(targets.length / batchSize),
          target_count: batch.length,
          total_target_count: targets.length,
          join_source: 'dashboard_group_join_campaign'
        }
      });
    }
    return jobs;
  }

  root.AmplrGroupJoinCampaign = {
    MAX_CAMPAIGN_TARGET,
    MAX_BATCH_SIZE,
    isSchedulableCandidate,
    candidateToJoinTarget,
    buildGroupJoinCampaignJobs
  };
})(typeof window !== 'undefined' ? window : globalThis);
