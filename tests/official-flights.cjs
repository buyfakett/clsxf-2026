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
