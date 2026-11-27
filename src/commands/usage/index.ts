import { Command } from 'commander';
import { usagePeriodsCommand } from './periods.ts';
import { usageSummaryCommand } from './summary.ts';
import { usageRangeCommand } from './range.ts';

export function makeUsageCommand(): Command {
  const cmd = new Command('usage').description('Show usage and estimated cost');
  cmd.addCommand(usagePeriodsCommand);
  cmd.addCommand(usageSummaryCommand);
  cmd.addCommand(usageRangeCommand);
  return cmd;
}
