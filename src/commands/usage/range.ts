import { usageWindowCommand } from './shared.ts';

export const usageRangeCommand = usageWindowCommand(
  'range',
  'Show the usage and estimated cost of a range of whole UTC days',
  '/usage/range',
  [
    {
      flags: '--start-date <date>',
      description: 'First UTC day of the range, as YYYY-MM-DD',
      required: true,
    },
    {
      flags: '--end-date <date>',
      description: 'Last UTC day of the range, included, as YYYY-MM-DD (at most 366 days)',
      required: true,
    },
  ],
  (opts) => ({
    start_date: opts['startDate'] as string,
    end_date: opts['endDate'] as string,
  }),
);
