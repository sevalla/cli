import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { usagePeriodsCommand } from '../../../src/commands/usage/periods.ts';
import { usageSummaryCommand } from '../../../src/commands/usage/summary.ts';
import { usageRangeCommand } from '../../../src/commands/usage/range.ts';
import { formatUsage } from '../../../src/commands/usage/shared.ts';
import { createProgram } from '../../../src/program.ts';

const period = {
  period_start: '2026-10-14T09:23:11.000Z',
  period_end: '2026-11-14T09:23:11.000Z',
  total_cost: 1234.5,
  usage_by_type: [
    { type: 'appCompute', total_usage: 2678400, unit_price: 0.00000077, cost: 1230.4 },
    { type: 'db', total_usage: 86400, unit_price: 0.0000475, cost: 4.1 },
  ],
};

const summary = {
  ...period,
  days: [
    {
      date: '2026-10-14',
      total_cost: 39.82,
      usage_by_type: [
        { type: 'appCompute', total_usage: 86400, unit_price: 0.00000077, cost: 39.82 },
      ],
    },
  ],
  services: [
    {
      service_id: 'fb5e5168-4281-4bec-94c5-0d1584e9e657',
      service_name: 'storefront',
      total_cost: 1230.4,
      usage_by_type: [period.usage_by_type[0]],
    },
    {
      service_id: null,
      service_name: null,
      total_cost: 4.1,
      usage_by_type: [period.usage_by_type[1]],
    },
  ],
};

describe('Usage commands', () => {
  let fetchMock: ReturnType<typeof mock.fn>;
  let logMock: ReturnType<typeof mock.fn>;
  let errorMock: ReturnType<typeof mock.fn>;
  let stderrMock: ReturnType<typeof mock.fn>;
  const isTTY = process.stdout.isTTY;

  function respond(body: unknown, status = 200): void {
    fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify(body), { status }));
  }

  function requestUrl(): URL {
    return new URL((fetchMock.mock.calls[0]?.arguments as [string])[0]);
  }

  function printed(output: ReturnType<typeof mock.fn>): string {
    return output.mock.calls.map((call) => call.arguments.join(' ')).join('\n');
  }

  beforeEach(() => {
    process.env['SEVALLA_API_TOKEN'] = 'tok';
    fetchMock = mock.fn();
    logMock = mock.fn();
    errorMock = mock.fn();
    mock.method(globalThis, 'fetch', fetchMock);
    mock.method(process, 'exit', () => {
      throw new Error('exit');
    });
    mock.method(console, 'log', logMock);
    mock.method(console, 'error', errorMock);
    // The spinner and commander's own errors write to stderr directly
    stderrMock = mock.fn(() => true);
    mock.method(process.stderr, 'write', stderrMock);
    respond(summary);
  });

  afterEach(() => {
    mock.restoreAll();
    process.stdout.isTTY = isTTY;
  });

  describe('periods', () => {
    it('should request the periods with the filters and print the list as JSON', async () => {
      respond({ data: [period] });
      await usagePeriodsCommand.parseAsync(
        [
          '--limit',
          '3',
          '--project',
          'p1',
          '--services',
          's1,s2',
          '--types',
          'appCompute,db',
          '--json',
        ],
        { from: 'user' },
      );
      const url = requestUrl();
      assert.match(url.pathname, /\/usage\/periods$/);
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        limit: '3',
        project_id: 'p1',
        service_ids: 's1,s2',
        types: 'appCompute,db',
      });
      assert.deepEqual(JSON.parse(printed(logMock)), [period]);
    });

    it('should send no query without options', async () => {
      respond({ data: [] });
      await usagePeriodsCommand.parseAsync(['--json'], { from: 'user' });
      assert.equal(requestUrl().search, '');
      assert.deepEqual(JSON.parse(printed(logMock)), []);
    });

    it('should print a table with the cost in USD on a terminal', async () => {
      process.stdout.isTTY = true;
      respond({ data: [period] });
      await usagePeriodsCommand.parseAsync([], { from: 'user' });
      const table = printed(logMock);
      for (const text of [
        'Period Start',
        '2026-10-14T09:23:11.000Z',
        '2026-11-14T09:23:11.000Z',
        '$1,234.50',
        'appCompute $1,230.40',
        'db $4.10',
      ]) {
        assert.ok(table.includes(text), `expected "${text}" in:\n${table}`);
      }
    });
  });

  describe('summary', () => {
    it('should request the current billing period without options and print the response', async () => {
      await usageSummaryCommand.parseAsync(['--json'], { from: 'user' });
      const url = requestUrl();
      assert.match(url.pathname, /\/usage\/summary$/);
      assert.equal(url.search, '');
      assert.deepEqual(JSON.parse(printed(logMock)), summary);
    });

    it('should send the period, the filters and the included parts', async () => {
      await usageSummaryCommand.parseAsync(
        [
          '--period-start',
          '2026-10-14T09:23:11.000Z',
          '--period-end',
          '2026-11-14T09:23:11.000Z',
          '--project',
          'p1',
          '--services',
          's1,s2',
          '--types',
          'db',
          '--include',
          'days,services',
          '--json',
        ],
        { from: 'user' },
      );
      assert.deepEqual(Object.fromEntries(requestUrl().searchParams), {
        period_start: '2026-10-14T09:23:11.000Z',
        period_end: '2026-11-14T09:23:11.000Z',
        project_id: 'p1',
        service_ids: 's1,s2',
        types: 'db',
        include: 'days,services',
      });
    });

    for (const flag of ['--period-start', '--period-end']) {
      it(`should send no request for ${flag} alone`, async () => {
        await assert.rejects(() =>
          usageSummaryCommand.parseAsync([flag, '2026-10-14T09:23:11.000Z', '--json'], {
            from: 'user',
          }),
        );
        assert.equal(fetchMock.mock.callCount(), 0);
        assert.match(printed(errorMock), /--period-start and --period-end must be used together/);
      });
    }

    it('should print the period, then the types, days and services on a terminal', async () => {
      process.stdout.isTTY = true;
      await usageSummaryCommand.parseAsync(['--include', 'days,services'], { from: 'user' });
      const output = printed(logMock);
      const positions = [
        'Period Start',
        '$1,234.50',
        'Usage by type',
        '$0.00000077',
        'Usage by day',
        // The trailing space tells the day apart from the period start
        '2026-10-14 ',
        '$39.82',
        'Usage by service',
        'storefront',
      ].map((text) => output.indexOf(text));
      assert.ok(!positions.includes(-1), `missing text in:\n${output}`);
      assert.deepEqual(
        positions,
        positions.toSorted((a, b) => a - b),
      );
    });

    it('should leave out the days and services tables when they are not included', async () => {
      process.stdout.isTTY = true;
      respond(period);
      await usageSummaryCommand.parseAsync([], { from: 'user' });
      const output = printed(logMock);
      assert.ok(output.includes('Usage by type'));
      assert.ok(!output.includes('Usage by day'));
      assert.ok(!output.includes('Usage by service'));
    });
  });

  describe('range', () => {
    it('should request the range of days with the filters and print the response', async () => {
      await usageRangeCommand.parseAsync(
        [
          '--start-date',
          '2026-11-01',
          '--end-date',
          '2026-11-07',
          '--project',
          'p1',
          '--services',
          's1',
          '--types',
          'appCompute',
          '--include',
          'days',
          '--json',
        ],
        { from: 'user' },
      );
      const url = requestUrl();
      assert.match(url.pathname, /\/usage\/range$/);
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        start_date: '2026-11-01',
        end_date: '2026-11-07',
        project_id: 'p1',
        service_ids: 's1',
        types: 'appCompute',
        include: 'days',
      });
      assert.deepEqual(JSON.parse(printed(logMock)), summary);
    });

    it('should send no request without --end-date', async () => {
      await assert.rejects(() =>
        usageRangeCommand.parseAsync(['--start-date', '2026-11-01', '--json'], { from: 'user' }),
      );
      assert.equal(fetchMock.mock.callCount(), 0);
      assert.match(printed(stderrMock), /required option '--end-date <date>' not specified/);
    });

    it('should print the tables on a terminal', async () => {
      process.stdout.isTTY = true;
      await usageRangeCommand.parseAsync(
        ['--start-date', '2026-11-01', '--end-date', '2026-11-07'],
        {
          from: 'user',
        },
      );
      const output = printed(logMock);
      for (const text of [
        'Total Cost',
        '$1,234.50',
        'Usage by type',
        'Usage by day',
        'Usage by service',
      ]) {
        assert.ok(output.includes(text), `expected "${text}" in:\n${output}`);
      }
    });
  });

  describe('API errors', () => {
    const noSubscription = {
      message:
        'The company has no active subscription, so it has no billing periods to report usage for.',
      status: 404,
      data: {},
    };
    const busy = {
      message: 'Too many usage requests in progress for this company. Retry in a moment.',
      status: 429,
    };

    for (const [name, command, args] of [
      ['summary', usageSummaryCommand, []],
      ['range', usageRangeCommand, ['--start-date', '2026-11-01', '--end-date', '2026-11-07']],
    ] as const) {
      it(`should report the 404 of ${name} for a company without an active subscription`, async () => {
        respond(noSubscription, 404);
        await assert.rejects(() => command.parseAsync([...args, '--json'], { from: 'user' }));
        assert.deepEqual(JSON.parse(printed(errorMock)), {
          error: { status: 404, message: noSubscription.message },
        });
        assert.equal(logMock.mock.callCount(), 0);
      });
    }

    for (const [name, command, args] of [
      ['periods', usagePeriodsCommand, []],
      ['summary', usageSummaryCommand, []],
      ['range', usageRangeCommand, ['--start-date', '2026-11-01', '--end-date', '2026-11-07']],
    ] as const) {
      it(`should report the 429 of ${name} once, without retrying`, async () => {
        respond(busy, 429);
        await assert.rejects(() => command.parseAsync([...args, '--json'], { from: 'user' }));
        assert.equal(fetchMock.mock.callCount(), 1);
        assert.deepEqual(JSON.parse(printed(errorMock)), {
          error: { status: 429, message: busy.message },
        });
      });
    }

    it('should print the status and message of an error on a terminal', async () => {
      process.stdout.isTTY = true;
      respond(busy, 429);
      await assert.rejects(() => usageSummaryCommand.parseAsync([], { from: 'user' }));
      assert.ok(printed(errorMock).includes(`Error 429: ${busy.message}`));
    });
  });

  it('should be registered with the options the schema describes', () => {
    const usage = createProgram().commands.find((c) => c.name() === 'usage');
    assert.deepEqual(
      usage?.commands.map((c) => c.name()),
      ['periods', 'summary', 'range'],
    );
    const options = (name: string) =>
      usage?.commands.find((c) => c.name() === name)?.options.map((o) => [o.flags, o.mandatory]);
    const filters = [
      ['--project <id>', false],
      ['--services <ids>', false],
      ['--types <types>', false],
    ];
    assert.deepEqual(options('periods'), [
      ['--json', false],
      ['--limit <number>', false],
      ...filters,
    ]);
    assert.deepEqual(options('summary'), [
      ['--json', false],
      ['--period-start <datetime>', false],
      ['--period-end <datetime>', false],
      ...filters,
      ['--include <parts>', false],
    ]);
    assert.deepEqual(options('range'), [
      ['--json', false],
      ['--start-date <date>', true],
      ['--end-date <date>', true],
      ...filters,
      ['--include <parts>', false],
    ]);
  });
});

describe('formatUsage', () => {
  it('groups thousands and keeps at most two decimals', () => {
    assert.equal(formatUsage(1492139827.738047), '1,492,139,827.74');
    assert.equal(formatUsage(86400), '86,400');
    assert.equal(formatUsage(0), '0');
  });
});
