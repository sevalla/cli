import chalk from 'chalk';
import { Command } from 'commander';
import { createClient } from '../../client/api-client.ts';
import type { QueryParams } from '../../client/types.ts';
import { handleError } from '../../errors/handler.ts';
import { jsonOption, resolveJsonMode } from '../../helpers/flags.ts';
import { printJson, printResource, printTable } from '../../output/formatter.ts';
import { startSpinner, stopSpinner } from '../../output/spinner.ts';

type UsageOption = { flags: string; description: string; required?: boolean };

interface UsageByType {
  type: string;
  total_usage: number;
  unit_price: number;
  cost: number;
}

interface UsageTotals {
  total_cost: number;
  usage_by_type: UsageByType[];
}

export interface UsagePeriod extends UsageTotals {
  period_start: string;
  period_end: string;
}

interface UsageSummary extends UsagePeriod {
  days?: Array<UsageTotals & { date: string }>;
  services?: Array<UsageTotals & { service_id: string | null; service_name: string | null }>;
}

// Shared by periods, summary and range, which take the same filters
export const usageFilterOptions: UsageOption[] = [
  { flags: '--project <id>', description: 'Only the usage of the services in this project' },
  {
    flags: '--services <ids>',
    description:
      'Comma-separated IDs of the services to count: applications, databases, static sites, object storage buckets and load balancers',
  },
  {
    flags: '--types <types>',
    description:
      'Comma-separated usage types to count: appCompute, appStorage, appBuild, appBandwidth, staticSiteBuild, staticSiteBandwidth, db, objectStorage, loadBalancer, loadBalancerBandwidth (default: all)',
  },
];

export function usageFilterQuery(opts: Record<string, unknown>): QueryParams {
  return {
    project_id: opts['project'],
    service_ids: opts['services'],
    types: opts['types'],
    include: opts['include'],
  } as QueryParams;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
// Unit prices are far below a cent, so they keep their digits instead of two decimals
const unitPrice = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumSignificantDigits: 6,
});

export const formatUsd = (amount: number): string => usd.format(amount);

const usageAmount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export const formatUsage = (amount: number): string => usageAmount.format(amount);

export const costByType = (item: UsageTotals): string =>
  item.usage_by_type.map((usage) => `${usage.type} ${formatUsd(usage.cost)}`).join('\n');

function printUsageSummary(result: UsageSummary): void {
  printResource({
    'Period Start': result.period_start,
    'Period End': result.period_end,
    'Total Cost': formatUsd(result.total_cost),
  });

  console.log(chalk.bold('Usage by type'));
  printTable(result.usage_by_type, [
    { header: 'Type', key: 'type' },
    { header: 'Usage', get: (usage) => formatUsage(usage.total_usage) },
    { header: 'Unit Price', get: (usage) => unitPrice.format(usage.unit_price) },
    { header: 'Cost', get: (usage) => formatUsd(usage.cost) },
  ]);

  if (result.days) {
    console.log(chalk.bold('Usage by day'));
    printTable(result.days, [
      { header: 'Date', key: 'date' },
      { header: 'Total Cost', get: (day) => formatUsd(day.total_cost) },
      { header: 'Cost by Type', get: costByType },
    ]);
  }

  if (result.services) {
    console.log(chalk.bold('Usage by service'));
    printTable(result.services, [
      { header: 'Service ID', key: 'service_id' },
      { header: 'Name', key: 'service_name' },
      { header: 'Total Cost', get: (service) => formatUsd(service.total_cost) },
      { header: 'Cost by Type', get: costByType },
    ]);
  }
}

// summary and range differ only in how the window is given
export function usageWindowCommand(
  name: string,
  description: string,
  path: string,
  windowOptions: UsageOption[],
  windowQuery: (opts: Record<string, unknown>) => QueryParams,
): Command {
  const cmd = new Command(name).description(description);
  cmd.addOption(jsonOption());
  for (const opt of [
    ...windowOptions,
    ...usageFilterOptions,
    {
      flags: '--include <parts>',
      description: 'Comma-separated breakdowns to add: days, services',
    },
  ]) {
    if (opt.required) cmd.requiredOption(opt.flags, opt.description);
    else cmd.option(opt.flags, opt.description);
  }

  return cmd.action(async (opts: Record<string, unknown>) => {
    const client = createClient({ apiUrl: opts['apiUrl'] as string | undefined });
    const json = resolveJsonMode(opts);
    try {
      const query = { ...windowQuery(opts), ...usageFilterQuery(opts) };
      if (!json) startSpinner('Fetching...');
      const result = await client.get<UsageSummary>(path, query);
      stopSpinner();
      if (json) printJson(result);
      else printUsageSummary(result);
    } catch (error) {
      stopSpinner();
      handleError(error, json);
    }
  });
}
