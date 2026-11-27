import { SevallaCliError } from '../../errors/cli-error.ts';
import { usageWindowCommand } from './shared.ts';

export const usageSummaryCommand = usageWindowCommand(
  'summary',
  'Show the usage and estimated cost of a billing period (default: the current one)',
  '/usage/summary',
  [
    {
      flags: '--period-start <datetime>',
      description:
        'Start of the period (ISO 8601), the period_start of a "usage periods" item; needs --period-end',
    },
    {
      flags: '--period-end <datetime>',
      description:
        'End of the period (ISO 8601), the period_end of a "usage periods" item; needs --period-start',
    },
  ],
  (opts) => {
    if ((opts['periodStart'] === undefined) !== (opts['periodEnd'] === undefined)) {
      throw new SevallaCliError(
        '--period-start and --period-end must be used together. Leave both out for the current billing period.',
      );
    }
    return {
      period_start: opts['periodStart'] as string | undefined,
      period_end: opts['periodEnd'] as string | undefined,
    };
  },
);
