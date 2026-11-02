const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');

// Exercise the helpers shipped to users, not the development copy in work/.
// Live snapshot counts and contents are intentionally not test expectations.
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const helperStart = html.indexOf('var officialSelectedDate =');
const helperEnd = html.indexOf('\nconst P =', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'Cannot locate the official snapshot helpers in index.html');
const helperSource = html.slice(helperStart, helperEnd);

function fixtures() {
  const flight = (flightNo, extra = {}) => ({
    flightNo, departureAirport: '杭州萧山', arrivalAirport: '广州白云',
    scheduledDeparture: '22:55', scheduledArrival: '00:40',
    arrivalDayOffset: null, flightDate: '2026-11-02', ...extra
  });
  const query = (from, to, extra = {}) => ({
    from, to, date: '2026-11-02', status: 'ok', flights: [],
    sourceUrl: 'https://www.loongair.cn/#/web/ticket/flightDynamic',
    checkedAt: '2026-11-02T03:00:00Z', ...extra
  });
  return {
    date: '2026-11-02', retrievedAt: '2026-11-02T04:00:00Z',
    airportCodes: { 杭州: 'HGH', 广州: 'CAN', 北京首都: 'PEK' },
    queries: [
      query('杭州', '广州', { flights: [flight('FIXTURE-OLD')], checkedAt: '2026-11-02T02:00:00Z' }),
      query('杭州', '广州', { flights: [flight('FIXTURE-OUTBOUND')] }),
      query('广州', '杭州', { flights: [flight('FIXTURE-RETURN', {
        departureAirport: '广州白云', arrivalAirport: '杭州萧山',
        scheduledDeparture: '09:00', scheduledArrival: '11:20', arrivalDayOffset: 0
      })] }),
      query('杭州', '广州', { date: '2026-11-03', flights: [flight('FIXTURE-NEXT-DATE', {
        flightDate: '2026-11-03', scheduledDeparture: '10:00', scheduledArrival: '12:00'
      })] }),
      query('杭州', '北京首都', { flights: [flight('FIXTURE-NEXT-DAY-ARRIVAL', {
        arrivalAirport: '北京首都', arrivalDayOffset: 1
      })] }),
      query('广州', '北京首都', { status: 'no-results' }),
      query('杭州', '未核实机场', { status: 'unmapped' }),
      query('杭州', '查询错误', { status: 'error' }),
      query('杭州', '未知状态', { status: 'unexpected-status' }),
      query('杭州', '日期不符', { flights: [flight('FIXTURE-WRONG-DATE', { flightDate: '2026-11-03' })] })
    ]
  };
}
function harness(snapshot = fixtures()) {
  const nodes = new Map(), listeners = [], renders = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', innerHTML: '' });
    return nodes.get(id);
  };
  const context = vm.createContext({
    officialFlightData: snapshot,
    selected: '杭州', roundTripOnly: true,
    camera: { x: 200, y: 100, w: 500, h: 300 },
    document: {
      getElementById: node,
      addEventListener: (type, listener) => listeners.push({ type, listener })
    },
    render: () => renders.push({ selected: context.selected, roundTripOnly: context.roundTripOnly, camera: { ...context.camera } }),
    setSelected: () => { throw new Error('A date change must not reset the selected city'); },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    URL, Intl, Date
  });
  vm.runInContext(helperSource, context, { filename: 'index.html:official-snapshot-helpers' });
  return { run: code => vm.runInContext(code, context), context, node, listeners, renders };
}
function countDirections(markup) {
  return (markup.match(/class="official-direction"/g) || []).length;
}

test('snapshots use the exact route, date and latest matching query', () => {
  const { run } = harness();
  assert.equal(run('officialFlightDateValue()'), '2026-11-02');
  const markup = run("officialRouteDetails('杭州', '广州')");
  assert.match(markup, /FIXTURE-OUTBOUND/);
  assert.doesNotMatch(markup, /FIXTURE-OLD|FIXTURE-RETURN|FIXTURE-NEXT-DATE/);
  assert.doesNotMatch(run("officialRouteDetails('杭州', '日期不符')"), /FIXTURE-WRONG-DATE/);
  assert.match(run("officialRouteDetails('杭州', '日期不符')"), /暂无明细/);
  assert.equal(run("officialFormattedTime('2026-11-02')"), '2026-11-02');
  assert.equal(run("officialFormattedTime('2026-11-02T03:00:00Z')"), '2026-11-02 11:00');
});

test('outbound and return are independent and the reverse direction is opt-in', () => {
  const { run } = harness();
  const single = run("officialRouteDetails('杭州', '广州')");
  assert.equal(countDirections(single), 1);
  assert.match(single, /FIXTURE-OUTBOUND/);
  assert.doesNotMatch(single, /FIXTURE-RETURN/);
  const both = run("officialRouteDetails('杭州', '广州', true)");
  assert.equal(countDirections(both), 2);
  assert.match(both, /杭州 → 广州/);
  assert.match(both, /广州 → 杭州/);
  assert.match(both, /FIXTURE-OUTBOUND/);
  assert.match(both, /FIXTURE-RETURN/);
  const unknownReturn = run("officialRouteDetails('杭州', '北京首都', true)");
  assert.equal(countDirections(unknownReturn), 2);
  assert.equal((unknownReturn.match(/FIXTURE-NEXT-DAY-ARRIVAL/g) || []).length, 1);
  assert.match(unknownReturn, /尚未保存/);
});

test('unknown, failed, unmapped and no-results states remain distinguishable', () => {
  const { run } = harness();
  const missing = run("officialRouteDetails('北京首都', '广州')");
  assert.match(missing, /尚未保存/);
  assert.doesNotMatch(missing, /查询无结果|未返回该日航班|没有航班/);
  const noResults = run("officialRouteDetails('广州', '北京首都')");
  assert.match(noResults, /查询无结果/);
  assert.match(noResults, /未返回该日航班/);
  assert.doesNotMatch(noResults, /尚未保存/);
  assert.match(run("officialRouteDetails('杭州', '未核实机场')"), /机场待核实/);
  assert.match(run("officialRouteDetails('杭州', '查询错误')"), /查询未完成/);
  const unexpected = run("officialRouteDetails('杭州', '未知状态')");
  assert.match(unexpected, /暂无明细/);
  assert.doesNotMatch(unexpected, /查询无结果|未返回该日航班/);
});

test('date changes render again while preserving city, filter and map camera', () => {
  const { run, context, node, listeners, renders } = harness();
  const camera = { ...context.camera };
  run('initOfficialFlightUI(); initOfficialFlightUI()');
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].type, 'change');
  listeners[0].listener({ target: { id: 'officialFlightDate', value: '2026-11-03' } });
  assert.equal(run('officialFlightDateValue()'), '2026-11-03');
  assert.equal(node('officialFlightDate').value, '2026-11-03');
  assert.equal(renders.length, 1);
  assert.equal(context.selected, '杭州');
  assert.equal(context.roundTripOnly, true);
  assert.deepEqual({ ...context.camera }, camera);
  assert.deepEqual(renders[0], { selected: '杭州', roundTripOnly: true, camera });
  const markup = run("officialRouteDetails('杭州', '广州')");
  assert.match(markup, /FIXTURE-NEXT-DATE/);
  assert.doesNotMatch(markup, /FIXTURE-OUTBOUND/);
  assert.equal(run("setOfficialFlightDate('2026-02-30')"), false);
  assert.equal(renders.length, 1);
  assert.equal(run('officialFlightDateValue()'), '2026-11-03');
  const invalidInput = { id: 'officialFlightDate', value: '' };
  listeners[0].listener({ target: invalidInput });
  assert.equal(invalidInput.value, '2026-11-03');
});

test('an unsaved date links to that exact official route and date without reusing old flights', () => {
  const { run } = harness();
  run("setOfficialFlightDate('2026-11-04')");
  assert.match(run('officialFlightMetaText()'), /所选日期尚未查询/);
  const markup = run("officialRouteDetails('杭州', '广州')");
  assert.match(markup, /尚未保存 2026-11-04/);
  assert.doesNotMatch(markup, /FIXTURE-OUTBOUND|FIXTURE-NEXT-DATE|查询无结果/);
  const link = run("officialQueryLink('杭州', '广州')");
  assert.ok(link.startsWith('https://www.loongair.cn/#/web/ticket/flightDynamic?param='));
  const payload = JSON.parse(Buffer.from(link.split('?param=')[1], 'base64').toString('utf8'));
  assert.deepEqual(payload, { C1: 'HGH', C2: 'CAN', T: '2026-11-04', F: 'GJ', Q: '1' });
  assert.equal(run("officialQueryLink('杭州', '未核实机场')"), 'https://www.loongair.cn/#/web/ticket/flightDynamic');
});

test('date changes keep expanded flight details open after the route list is rebuilt', () => {
  const { run, context } = harness();
  const detail = (from, to, open = false) => ({ dataset: { officialFrom: from, officialTo: to }, open });
  let details = [detail('杭州', '广州', true), detail('杭州', '北京首都')];
  context.document.querySelectorAll = selector => selector === '.official-details[open]' ? details.filter(element => element.open) : details;
  context.render = () => { details = [detail('杭州', '广州'), detail('杭州', '北京首都')]; };
  run("setOfficialFlightDate('2026-11-03')");
  assert.equal(details[0].open, true);
  assert.equal(details[1].open, false);
  assert.match(run('officialFlightMetaText()'), /1 个方向已收录 1 条航班记录/);
});

test('source links allow HTTPS official hosts and safely reject other destinations', () => {
  const { run, context } = harness();
  for (const value of [
    'javascript:alert(1)', 'data:text/html,hello', 'http://www.loongair.cn/',
    'https://loongair.cn.attacker.test/', 'https://attacker.test/?next=https://www.loongair.cn/'
  ]) assert.equal(run(`officialSafeSource(${JSON.stringify(value)})`), '');
  assert.equal(run("officialSafeSource('https://www.loongair.cn/#/web/ticket/flightDynamic')"), 'https://www.loongair.cn/#/web/ticket/flightDynamic');
  context.officialFlightData.queries.find(q => q.from === '广州' && q.to === '杭州').sourceUrl = 'javascript:alert(1)';
  const markup = run("officialRouteDetails('广州', '杭州')");
  assert.doesNotMatch(markup, /javascript:|alert\(1\)/);
  assert.match(markup, /href="https:\/\/www\.loongair\.cn\//);
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
});

test('a lower arrival clock never implies next-day arrival when the source offset is null', () => {
  const { run } = harness();
  const unknownOffset = run("officialRouteDetails('杭州', '广州')");
  assert.match(unknownOffset, /22:55/);
  assert.match(unknownOffset, /00:40/);
  assert.doesNotMatch(unknownOffset, /<sup/);
  const knownOffset = run("officialRouteDetails('杭州', '北京首都')");
  assert.match(knownOffset, /<sup[^>]*>\+1<\/sup>/);
  assert.doesNotMatch(run("officialRouteDetails('广州', '杭州')"), /<sup/);
});

test('rendered fields escape markup and the date controls identify snapshot behavior', () => {
  const { run, context } = harness();
  context.officialFlightData.queries.find(q => q.flights[0]?.flightNo === 'FIXTURE-OUTBOUND').flights[0].flightNo = '<img src=x onerror=alert(1)>';
  const markup = run("officialRouteDetails('杭州', '广州')");
  assert.doesNotMatch(markup, /<img/);
  assert.match(markup, /&lt;img/);
  const controls = run('officialFlightControls()');
  assert.match(controls, /id="officialFlightDate"/);
  assert.match(controls, /快照/);
  assert.match(controls, /不会实时查票/);
});

test('collected flight statuses display safely without inventing absent statuses', () => {
  const { run, context } = harness();
  const flight = context.officialFlightData.queries.find(q => q.flights[0]?.flightNo === 'FIXTURE-OUTBOUND').flights[0];
  const absent = run("officialRouteDetails('杭州', '广州')");
  assert.doesNotMatch(absent, /class="official-flight-status|is-cancelled/);
  assert.doesNotMatch(absent, /航班正常/);
  flight.flightStatus = '航班取消';
  const cancelled = run("officialRouteDetails('杭州', '广州')");
  assert.match(cancelled, /class="official-flight-status cancelled">航班取消/);
  assert.match(cancelled, /class="official-flight is-cancelled"/);
  flight.flightStatus = '航班延误';
  const delayed = run("officialRouteDetails('杭州', '广州')");
  assert.match(delayed, /class="official-flight-status delayed">航班延误/);
  assert.doesNotMatch(delayed, /is-cancelled/);
  flight.flightStatus = '<img src=x onerror=alert(1)>取消';
  const unsafe = run("officialRouteDetails('杭州', '广州')");
  assert.doesNotMatch(unsafe, /<img/);
  assert.match(unsafe, /&lt;img/);
  flight.flightStatus = '未取消';
  assert.doesNotMatch(run("officialRouteDetails('杭州', '广州')"), /official-flight-status cancelled|is-cancelled/);
  flight.flightStatus = '   ';
  assert.doesNotMatch(run("officialRouteDetails('杭州', '广州')"), /class="official-flight-status/);
});

function futureFixtures() {
  const snapshot = fixtures();
  snapshot.searchWindow = { startDate: '2026-11-03', endDate: '2026-12-02' };
  snapshot.coverage = { referenceDirections: 3 };
  const query = (from, to, date, flightNo, extra = {}) => ({
    from, to, date, status: 'ok', checkedAt: '2026-11-02T04:00:00Z',
    sourceUrl: 'https://www.loongair.cn/#/web/ticket/flightDynamic',
    flights: [{ flightNo, departureAirport: from, arrivalAirport: to,
      scheduledDeparture: '10:00', scheduledArrival: '12:00', arrivalDayOffset: null,
      flightDate: date }], ...extra
  });
  snapshot.queries.push(
    query('杭州', '广州', '2026-11-04', 'FUTURE-SUPERSEDED', { checkedAt: '2026-11-02T03:00:00Z' }),
    query('杭州', '广州', '2026-11-04', 'FUTURE-LATEST'),
    query('广州', '杭州', '2026-11-05', 'FUTURE-RETURN'),
    query('杭州', '广州', '2026-11-06', 'FUTURE-CANCELLED', {
      flights: [{ flightNo: 'FUTURE-CANCELLED', flightDate: '2026-11-06', flightStatus: '航班取消' }]
    }),
    query('杭州', '广州', '2026-11-07', 'FUTURE-WRONG-DATE', {
      flights: [{ flightNo: 'FUTURE-WRONG-DATE', flightDate: '2026-11-02' }]
    }),
    query('杭州', '广州', '2026-11-08', 'FUTURE-UNCONFIRMED', { status: 'error', flights: [] }),
    query('杭州', '广州', '2026-12-03', 'FUTURE-OUTSIDE-WINDOW')
  );
  return snapshot;
}
function futureHarness(snapshot = futureFixtures(), today = '2026-11-02') {
  const result = harness(snapshot);
  result.context.officialToday = () => today;
  return result;
}

test('future view defaults to the configured window and lists only actual confirmed dates', () => {
  const { run } = futureHarness();
  assert.equal(run('officialFlightViewValue()'), 'future');
  const markup = run("officialRouteDetails('杭州', '广州')");
  assert.match(markup, /未来已核实 2 班/);
  assert.match(markup, /最早已查到出发：2026-11-03/);
  assert.match(markup, /已查到日期：2026-11-03、2026-11-04/);
  assert.match(markup, /FIXTURE-NEXT-DATE/);
  assert.match(markup, /FUTURE-LATEST/);
  assert.doesNotMatch(markup, /FIXTURE-OUTBOUND|FUTURE-SUPERSEDED|FUTURE-CANCELLED|FUTURE-WRONG-DATE|FUTURE-UNCONFIRMED|FUTURE-OUTSIDE-WINDOW/);
  assert.match(run('officialFlightMetaText()'), /2 个方向已收录 3 条航班记录，涉及 3 个出发日期/);
  assert.match(run('officialFlightMetaText()'), /1 个方向尚未取得未来航班明细/);
  const controls = run('officialFlightControls()');
  assert.match(controls, /<select id="officialFlightView">/);
  assert.match(controls, /查询范围：2026-11-03—2026-12-02/);
  assert.doesNotMatch(controls, /id="officialFlightDate"/);
});

test('future round trips show independent departure dates rather than imply a matched itinerary', () => {
  const { run } = futureHarness();
  const single = run("officialRouteDetails('杭州', '广州')");
  assert.equal(countDirections(single), 1);
  assert.doesNotMatch(single, /FUTURE-RETURN/);
  const mutual = run("officialRouteDetails('杭州', '广州', true)");
  assert.equal(countDirections(mutual), 2);
  assert.match(mutual, /未来已核实 3 班/);
  assert.match(mutual, /杭州 → 广州/);
  assert.match(mutual, /广州 → 杭州/);
  assert.match(mutual, /FUTURE-RETURN/);
  assert.match(mutual, /最早已查到出发：2026-11-05/);
});

test('future metadata separates the current target set from extra findings and historical-only routes', () => {
  const snapshot = futureFixtures();
  snapshot.coverage.referenceDirections = 402;
  snapshot.futureTargetDirections = [
    { from: '杭州', to: '广州' },
    { from: '杭州', to: '北京首都' }
  ];
  const { run } = futureHarness(snapshot);
  const metadata = run('officialFlightMetaText()');
  assert.match(metadata, /未来范围内：2 个方向已收录 3 条航班记录/);
  assert.match(metadata, /本轮补查 2 个方向，其中 1 个已核实、1 个待核实/);
  assert.doesNotMatch(metadata, /400 个方向尚未取得未来航班明细/);
  // The extra return flight counts overall, but cannot complete either target.
  snapshot.queries = snapshot.queries.filter(q => q.from !== '杭州' || q.to !== '广州' || q.date === '2026-11-02');
  const onlyExtra = run('officialFlightMetaText()');
  assert.match(onlyExtra, /未来范围内：1 个方向已收录 1 条航班记录/);
  assert.match(onlyExtra, /本轮补查 2 个方向，其中 0 个已核实、2 个待核实/);
  assert.match(run("officialRouteDetails('杭州', '北京首都')"), /未来日期待核实/);
  assert.match(run("officialRouteDetails('广州', '杭州')"), /FUTURE-RETURN/);
});

test('expired dates and an expired future window never fall back to historical flights', () => {
  const { run, context } = futureHarness(undefined, '2026-11-04');
  const markup = run("officialRouteDetails('杭州', '广州')");
  assert.match(markup, /最早已查到出发：2026-11-04/);
  assert.doesNotMatch(markup, /FIXTURE-NEXT-DATE|FIXTURE-OUTBOUND/);
  context.officialToday = () => '2026-12-03';
  assert.equal(run('officialFlightViewValue()'), 'future');
  const expired = run("officialRouteDetails('杭州', '广州')");
  assert.match(expired, /查询范围已过期/);
  assert.doesNotMatch(expired, /FUTURE-LATEST|FIXTURE-OUTBOUND|FIXTURE-NEXT-DATE/);
  assert.match(run('officialFlightMetaText()'), /查询范围已过期/);
  assert.match(run('officialFlightControls()'), /查询范围：2026-11-03—2026-12-02（已过期）/);
});

test('a missing or cancelled-only future direction stays unknown without reusing a historical result', () => {
  const snapshot = futureFixtures();
  snapshot.queries = snapshot.queries.filter(q => q.from !== '杭州' || q.to !== '广州' || q.date === '2026-11-02' || q.date === '2026-11-06');
  const { run } = futureHarness(snapshot);
  const cancelledOnly = run("officialRouteDetails('杭州', '广州')");
  assert.match(cancelledOnly, /未来日期待核实/);
  assert.match(cancelledOnly, /未取得明细不表示没有航班/);
  assert.doesNotMatch(cancelledOnly, /FIXTURE-OUTBOUND|FUTURE-CANCELLED|班已收录|查询无结果/);
  assert.match(run("officialRouteDetails('杭州', '北京首都')"), /未来日期待核实/);
  assert.doesNotMatch(run("officialRouteDetails('杭州', '北京首都')"), /FIXTURE-NEXT-DAY-ARRIVAL/);
});

test('view switches preserve open details and map state while historical dates remain accessible', () => {
  const { run, context, listeners, renders } = futureHarness();
  const detail = (from, to, open = false) => ({ dataset: { officialFrom: from, officialTo: to }, open });
  let details = [detail('杭州', '广州', true), detail('杭州', '北京首都')];
  context.document.querySelectorAll = selector => selector === '.official-details[open]' ? details.filter(element => element.open) : details;
  const camera = { ...context.camera };
  context.render = () => { details = [detail('杭州', '广州'), detail('杭州', '北京首都')]; renders.push('rendered'); };
  run('initOfficialFlightUI()');
  listeners[0].listener({ target: { id: 'officialFlightView', value: 'date' } });
  assert.equal(run('officialFlightViewValue()'), 'date');
  assert.equal(run('officialFlightDateValue()'), '2026-11-02');
  assert.match(run("officialRouteDetails('杭州', '广州')"), /FIXTURE-OUTBOUND/);
  assert.match(run('officialFlightControls()'), /id="officialFlightDate"/);
  assert.equal(details[0].open, true);
  assert.equal(details[1].open, false);
  assert.equal(context.selected, '杭州');
  assert.equal(context.roundTripOnly, true);
  assert.deepEqual({ ...context.camera }, camera);
  assert.equal(run("setOfficialFlightView('future')"), true);
  assert.equal(run('officialFlightViewValue()'), 'future');
  assert.equal(details[0].open, true);
  assert.equal(run("setOfficialFlightDate('2026-11-04')"), true);
  assert.equal(run('officialFlightViewValue()'), 'date');
  assert.match(run("officialRouteDetails('杭州', '广州')"), /FUTURE-LATEST/);
  assert.doesNotMatch(run("officialRouteDetails('杭州', '广州')"), /FIXTURE-OUTBOUND|FIXTURE-NEXT-DATE/);
  assert.equal(run("setOfficialFlightView('invalid')"), false);
});

function throughFixtures() {
  const snapshot = futureFixtures();
  const segment = (departureAirport, arrivalAirport, scheduledDeparture, scheduledArrival) => ({
    flightNo: 'GJ8781', departureAirport, arrivalAirport, scheduledDeparture, scheduledArrival,
    arrivalDayOffset: null, flightDate: '2026-11-03'
  });
  snapshot.airportCodes.阿克苏 = 'AKU';
  snapshot.queries.push({
    from: '杭州', to: '阿克苏', date: '2026-11-03', status: 'ok', sourceKind: 'flight-number',
    sourceUrl: 'https://www.loongair.cn/#/web/ticket/flightDynamic?param=eyJDMSI6IkhHSCIsIkMyIjoiQ0FOIiwiVCI6IjIwMjYtMTEtMDMiLCJGIjoiR0o4NzgxIiwiUSI6IjAifQ%3D%3D',
    checkedAt: '2026-11-02T07:00:00Z',
    flights: [{
      flightNo: 'GJ8781', departureAirport: '杭州萧山国际机场', arrivalAirport: '阿克苏红旗坡机场',
      scheduledDeparture: '14:00', scheduledArrival: '22:10', arrivalDayOffset: null,
      flightDate: '2026-11-03', via: ['郑州'],
      segments: [
        segment('杭州萧山国际机场', '郑州新郑国际机场', '14:00', '16:00'),
        segment('郑州新郑国际机场', '阿克苏红旗坡机场', '17:05', '22:10')
      ]
    }]
  });
  return snapshot;
}

test('verified through flights show the stop and each actual leg rather than one endpoint arrow', () => {
  const { run } = futureHarness(throughFixtures());
  const markup = run("officialRouteDetails('杭州', '阿克苏')");
  assert.match(markup, /未来已核实 1 班/);
  assert.match(markup, /经停：郑州/);
  assert.match(markup, /同一航班号 · 2 段 · 需经停/);
  assert.match(markup, /第 1 段/);
  assert.match(markup, /第 2 段/);
  assert.equal((markup.match(/class="official-times"/g) || []).length, 2);
  assert.equal((markup.match(/<strong>GJ8781<\/strong>/g) || []).length, 3);
  assert.match(markup, /14:00/);
  assert.match(markup, /16:00/);
  assert.match(markup, /17:05/);
  assert.match(markup, /22:10/);
  assert.match(markup, /郑州新郑国际机场/);
  assert.match(markup, /官网航班号查询来源/);
  assert.match(markup, /不代表实时在售或畅飞卡可兑换/);
  run("setOfficialFlightDate('2026-11-03')");
  const exact = run("officialRouteDetails('杭州', '阿克苏')");
  assert.match(exact, /经停：郑州/);
  assert.match(exact, /官网航班号查询来源/);
});

test('through records require all legs to share the actual query date and flight number', () => {
  const snapshot = throughFixtures();
  const flight = snapshot.queries.find(q => q.to === '阿克苏').flights[0];
  const { run } = futureHarness(snapshot);
  flight.segments[1].flightDate = '2026-11-04';
  assert.doesNotMatch(run("officialRouteDetails('杭州', '阿克苏')"), /GJ8781|班已收录/);
  assert.match(run("officialRouteDetails('杭州', '阿克苏')"), /未来日期待核实/);
  run("setOfficialFlightDate('2026-11-03')");
  assert.match(run("officialRouteDetails('杭州', '阿克苏')"), /暂无明细/);
  flight.segments[1].flightDate = '2026-11-03';
  flight.segments[1].flightNo = 'GJ9999';
  assert.doesNotMatch(run("officialRouteDetails('杭州', '阿克苏')"), /GJ8781|GJ9999/);
  flight.segments[1].flightNo = 'GJ8781';
  assert.match(run("officialRouteDetails('杭州', '阿克苏')"), /同一航班号/);
  flight.segments = [];
  assert.doesNotMatch(run("officialRouteDetails('杭州', '阿克苏')"), /GJ8781/);
});

test('a cancelled through leg excludes the whole future service and stays visible in exact-date history', () => {
  const snapshot = throughFixtures();
  const flight = snapshot.queries.find(q => q.to === '阿克苏').flights[0];
  flight.segments[1].flightStatus = '航班取消';
  const { run } = futureHarness(snapshot);
  assert.match(run("officialRouteDetails('杭州', '阿克苏')"), /未来日期待核实/);
  assert.doesNotMatch(run("officialRouteDetails('杭州', '阿克苏')"), /GJ8781/);
  run("setOfficialFlightDate('2026-11-03')");
  const exact = run("officialRouteDetails('杭州', '阿克苏')");
  assert.match(exact, /is-cancelled/);
  assert.match(exact, /航班取消（含经停段）/);
  assert.match(exact, /经停：郑州/);
});

test('through stop names, leg airports and source labels render safely', () => {
  const snapshot = throughFixtures();
  const flight = snapshot.queries.find(q => q.to === '阿克苏').flights[0];
  flight.via = ['郑州<script>alert(1)</script>'];
  flight.segments[0].arrivalAirport = '<img src=x onerror=alert(1)>郑州新郑国际机场';
  const { run } = futureHarness(snapshot);
  const markup = run("officialRouteDetails('杭州', '阿克苏')");
  assert.doesNotMatch(markup, /<script>|<img/);
  assert.match(markup, /郑州&lt;script&gt;/);
  assert.match(markup, /&lt;img/);
  assert.match(markup, /href="https:\/\/www\.loongair\.cn\/#\/web\/ticket\/flightDynamic\?param=/);
  assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
});
