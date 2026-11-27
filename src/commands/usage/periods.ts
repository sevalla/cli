import { makeListCommand } from '../../helpers/command-factory.ts';
import type { QueryParams } from '../../client/types.ts';
import { costByType, formatUsd, usageFilterOptions, usageFilterQuery } from './shared.ts';
import type { UsagePeriod } from './shared.ts';

export const usagePeriodsCommand = makeListCommand<UsagePeriod>({
  name: 'periods',
  description: 'List the billing periods with their usage and estimated cost, newest first',
  options: [
    {
      flags: '--limit <number>',
      description: 'Maximum billing periods, counted back from the current one (1-24, default: 12)',
    },
    ...usageFilterOptions,
  ],
  columns: [
    { header: 'Period Start', key: 'period_start' },
    { header: 'Period End', key: 'period_end' },
    { header: 'Total Cost', get: (period) => formatUsd(period.total_cost) },
    { header: 'Cost by Type', get: costByType },
  ],
  apiCall: (client, opts) =>
    client.get('/usage/periods', {
      limit: opts['limit'],
      ...usageFilterQuery(opts),
    } as QueryParams),
  paginated: false,
});
