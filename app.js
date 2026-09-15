const DATASETS = [
  {
    endpoint: 'getCredCardCompFinaInfo',
    group: 'financial',
    title: '신용카드_재무현황_요약재무상태표(자산)(07.12월이전)'
  },
  {
    endpoint: 'getCredCardCompMajoBusiActi',
    group: 'business',
    title: '신용카드_주요영업활동_신용카드이용실적'
  }
];

const tableBody = document.querySelector('#tableBody');
const chart = document.querySelector('#chart');
const notice = document.querySelector('#notice');
const loadButton = document.querySelector('#loadButton');
const keyInput = document.querySelector('#serviceKey');
const monthInput = document.querySelector('#basYm');
const historyStart = document.querySelector('#historyStart');
const historyEnd = document.querySelector('#historyEnd');
const companyFilters = document.querySelector('#companyFilters');
const historyButton = document.querySelector('#historyButton');
const historyChart = document.querySelector('#historyChart');
const historyNotice = document.querySelector('#historyNotice');
const numberFormat = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
let historyItems = [];
const TREND_COLORS = ['#2878e8', '#e35d6a', '#18a576', '#9a6fe5', '#df8a23', '#189bb3', '#74543d', '#56667d', '#e06baa'];

function setNotice(message, kind = 'info') {
  notice.textContent = message;
  notice.className = `notice ${kind}`;
}

function normalizeName(value) {
  return String(value || '').replace(/\s|주식회사|\(구\)/g, '');
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function valueText(value, suffix = '') {
  const number = toNumber(value);
  return number === null ? '제공값 없음' : `${numberFormat.format(number)}${suffix}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function itemsFromResponse(data) {
  const found = [];
  const seen = new Set();
  function scan(node) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (node.items) {
      const items = node.items.item ?? node.items;
      const list = Array.isArray(items) ? items : [items];
      list.filter(item => item && typeof item === 'object' && !Array.isArray(item)).forEach(item => found.push(item));
    }
    Object.values(node).forEach(scan);
  }
  scan(data);
  return found;
}

function responseError(data) {
  const raw = JSON.stringify(data);
  const messages = ['errMsg', 'resultMsg', 'returnAuthMsg'];
  for (const name of messages) {
    const match = raw.match(new RegExp(`"${name}":"([^"]+)"`));
    if (match && !/NORMAL SERVICE/i.test(match[1])) return match[1];
  }
  return null;
}

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await fetch(url, { cache: 'no-store' });
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
  throw new Error('로컬 조회 서버에 연결하지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.');
}

async function loadEndpoint(dataset, key, basYm) {
  const params = new URLSearchParams({ endpoint: dataset.endpoint, title: dataset.title, key, basYm });
  const response = await fetchWithRetry(`/api/cards?${params}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseError(data) || data.error || `HTTP ${response.status}`);
  const apiError = responseError(data);
  if (apiError) throw new Error(apiError);
  return itemsFromResponse(data);
}

function setHistoryNotice(message, isError = false) {
  historyNotice.textContent = message;
  historyNotice.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function isValidYear(value) {
  return /^\d{4}$/.test(value) && Number(value) >= 2000 && Number(value) <= 2100;
}

function formatTrillion(value) {
  return `${(value / 1_000_000_000_000).toFixed(1)}조`;
}

function populateCompanies(items) {
  const names = [...new Set(items.map(item => item.fncoNm).filter(name => name && name !== '신용카드사'))].sort((a, b) => a.localeCompare(b, 'ko'));
  companyFilters.innerHTML = names.length
    ? names.map(name => `<label class="company-filter"><input type="checkbox" value="${escapeHtml(name)}" checked> ${escapeHtml(name)}</label>`).join('')
    : '<span class="filter-placeholder">조회 기간에 데이터가 없습니다</span>';
}

function renderHistoryChart() {
  const startYear = historyStart.value.trim();
  const endYear = historyEnd.value.trim();
  const companies = [...companyFilters.querySelectorAll('input:checked')].map(input => input.value);
  const series = companies.map((company, index) => {
    const yearMap = new Map();
    historyItems.filter(item => item.fncoNm === company && item.basYm.slice(0, 4) >= startYear && item.basYm.slice(0, 4) <= endYear)
      .forEach(item => {
        const value = toNumber(item.crcdUzAtrsItemCmtlAmt);
        const year = item.basYm.slice(0, 4);
        const current = yearMap.get(year);
        if (value !== null && (!current || value >= current.value)) yearMap.set(year, { year, value, month: item.basYm });
      });
    return { company, color: TREND_COLORS[index % TREND_COLORS.length], points: [...yearMap.values()].sort((a, b) => a.year.localeCompare(b.year)) };
  }).filter(item => item.points.length);
  const years = [...new Set(series.flatMap(item => item.points.map(point => point.year)))].sort();
  if (!series.length) {
    historyChart.className = 'line-chart empty';
    historyChart.textContent = companies.length ? '선택한 카드사와 연도에 제공되는 총계 이용실적이 없습니다.' : '비교할 카드사를 하나 이상 선택해 주세요.';
    return;
  }
  const width = 760;
  const height = 300;
  const pad = { left: 62, right: 18, top: 26, bottom: 42 };
  const values = series.flatMap(item => item.points.map(point => point.value));
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const spread = Math.max(rawMax - rawMin, rawMax * 0.1, 1);
  const min = Math.max(0, rawMin - spread * 0.18);
  const max = rawMax + spread * 0.18;
  const x = year => pad.left + (width - pad.left - pad.right) * (years.length === 1 ? 0.5 : years.indexOf(year) / (years.length - 1));
  const y = value => pad.top + (height - pad.top - pad.bottom) * (1 - (value - min) / (max - min));
  const grid = [0, .5, 1].map(ratio => {
    const value = max - (max - min) * ratio;
    const pos = pad.top + (height - pad.top - pad.bottom) * ratio;
    return `<line class="grid-line" x1="${pad.left}" y1="${pos}" x2="${width - pad.right}" y2="${pos}" /><text class="axis-label" x="${pad.left - 8}" y="${pos + 4}" text-anchor="end">${formatTrillion(value)}</text>`;
  }).join('');
  const step = Math.max(1, Math.ceil(years.length / 6));
  const labels = years.map((year, index) => (index % step === 0 || index === years.length - 1)
    ? `<text class="axis-label" x="${x(year)}" y="${height - 14}" text-anchor="middle">${year}</text>` : '').join('');
  const paths = series.map(item => `<path class="trend-line" style="stroke:${item.color}" d="${item.points.map((point, index) => `${index ? 'L' : 'M'}${x(point.year).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ')}" />`).join('');
  const dots = series.flatMap(item => item.points.map(point => `<circle class="trend-point" style="stroke:${item.color}" cx="${x(point.year)}" cy="${y(point.value)}" r="4"><title>${item.company} · ${point.year}년 (${point.month} 기준): ${valueText(point.value)}</title></circle>`)).join('');
  const legend = series.map(item => `<span class="legend-item"><i class="legend-dot" style="background:${item.color}"></i>${escapeHtml(item.company)}</span>`).join('');
  historyChart.className = 'line-chart';
  historyChart.innerHTML = `<div class="chart-legend">${legend}</div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="선택한 카드사의 ${startYear}년부터 ${endYear}년까지 연도별 총계 이용실적 비교 그래프">${grid}${paths}${dots}${labels}<text class="trend-value" x="${pad.left}" y="16">카드사별 연도별 총계 이용실적</text></svg>`;
}

async function loadHistory() {
  const key = keyInput.value.trim();
  const startYear = historyStart.value.trim();
  const endYear = historyEnd.value.trim();
  if (!key) return setHistoryNotice('먼저 공공데이터포털 서비스키를 입력해 주세요.', true);
  if (!isValidYear(startYear) || !isValidYear(endYear) || startYear > endYear) return setHistoryNotice('시작·종료 연도를 YYYY 형식으로, 시작이 종료보다 앞서게 입력해 주세요.', true);
  const start = `${startYear}01`;
  const end = `${endYear}12`;
  historyButton.disabled = true;
  historyButton.textContent = '연도 데이터 조회 중…';
  setHistoryNotice('실제 API의 분기 누계 원본을 가져와 연도별로 집계하고 있습니다. 최초 조회는 다소 걸릴 수 있습니다.');
  try {
    const params = new URLSearchParams({ key, start, end });
    const response = await fetchWithRetry(`/api/history?${params}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(responseError(data) || data.error || `HTTP ${response.status}`);
    historyItems = data.items || [];
    populateCompanies(historyItems);
    renderHistoryChart();
    setHistoryNotice(`${companyFilters.querySelectorAll('input').length}개 카드사의 ${startYear}~${endYear} 실제 분기 누계 원본을 연도별로 집계했습니다. 체크를 해제해 비교 대상을 줄일 수 있습니다.`);
  } catch (error) {
    historyItems = [];
    companyFilters.innerHTML = '<span class="filter-placeholder">기간 데이터를 조회해 주세요</span>';
    historyChart.className = 'line-chart empty';
    historyChart.textContent = '기간 데이터 조회에 실패했습니다.';
    setHistoryNotice(`기간 조회 오류: ${error.message}`, true);
  } finally {
    historyButton.disabled = false;
    historyButton.textContent = '연도별 그래프 조회';
  }
}

function itemLabel(item) {
  const labelKey = Object.keys(item).find(key => /(?:CdNm|ItemNm|Nm)$/i.test(key) && !/^fncoNm$/i.test(key));
  return labelKey ? String(item[labelKey] ?? '') : '';
}

function numericValue(item, preferred = []) {
  const keys = Object.keys(item).filter(key => toNumber(item[key]) !== null && !/^(basYm|crno|fncoCd)$/i.test(key));
  const key = preferred.map(pattern => keys.find(candidate => pattern.test(candidate))).find(Boolean) || keys[0];
  return key ? toNumber(item[key]) : null;
}

function firstMatch(items, pattern, preferredKeys) {
  const match = items.find(item => pattern.test(itemLabel(item)) || pattern.test(JSON.stringify(item)));
  return match ? numericValue(match, preferredKeys) : null;
}

function mergeByCompany(groups, requestedMonth) {
  const companies = new Map();
  const upsert = item => {
    if (!item.fncoNm) return null;
    const id = item.fncoCd || normalizeName(item.fncoNm);
    if (!companies.has(id)) companies.set(id, { name: item.fncoNm, basYm: item.basYm || requestedMonth, financial: [], management: [], business: [] });
    return companies.get(id);
  };
  groups.financial.forEach(item => upsert(item)?.financial.push(item));
  (groups.management || []).forEach(item => upsert(item)?.management.push(item));
  groups.business.forEach(item => upsert(item)?.business.push(item));

  return [...companies.values()].map(company => ({
    ...company,
    // 항목명으로 찾으며, 제공되지 않은 지표는 null로 보존합니다.
    asset: firstMatch(company.financial, /(^|[_\s])(?:자산|총자산)(?:$|[_\s])|자산총계/, [/Amt$/i, /Val/i]),
    liability: firstMatch(company.financial, /(^|[_\s])(?:부채|총부채)(?:$|[_\s])|부채총계/, [/Amt$/i, /Val/i]),
    equity: firstMatch(company.financial, /자기자본|자본총계|총자본/, [/Amt$/i, /Val/i]),
    business: firstMatch(company.business, /총계_이용실적/, [/CmtlAmt$/i, /ThqrAmt$/i, /Amt$/i]),
    delinquency: firstMatch([...company.management, ...company.business], /연체.*(?:율|비율)|(?:율|비율).*연체/, [/Val/i, /Rto/i])
  })).filter(company => company.name !== '신용카드사')
    .filter(company => company.business !== null || company.asset !== null || company.liability !== null || company.equity !== null || company.delinquency !== null)
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

function renderTable(companies) {
  if (!companies.length) {
    tableBody.innerHTML = '<tr><td colspan="7" class="empty-cell">해당 기준년월에 비교 가능한 API 응답이 없습니다.</td></tr>';
    return;
  }
  tableBody.innerHTML = companies.map(company => `
    <tr>
      <td>${escapeHtml(company.name)}</td>
      <td>${escapeHtml(company.basYm)}</td>
      <td>${valueText(company.business)}</td>
      <td>${valueText(company.asset)}</td>
      <td>${valueText(company.liability)}</td>
      <td>${valueText(company.equity)}</td>
      <td>${valueText(company.delinquency, '%')}</td>
    </tr>`).join('');
}

function renderChart(companies) {
  const usable = companies.filter(company => company.business !== null && company.business >= 0);
  if (!usable.length) {
    chart.className = 'chart empty';
    chart.textContent = '주요 영업실적 항목이 API 응답에 없어 차트를 표시할 수 없습니다.';
    return;
  }
  const max = Math.max(...usable.map(company => company.business), 1);
  chart.className = 'chart';
  chart.innerHTML = usable.map(company => `
    <div class="bar-row">
      <span class="bar-label" title="${escapeHtml(company.name)}">${escapeHtml(company.name)}</span>
      <div class="bar-track"><div class="bar" style="width:${Math.max(1, company.business / max * 100)}%"></div></div>
      <span class="bar-value">${valueText(company.business)}</span>
    </div>`).join('');
}

async function loadData() {
  const key = keyInput.value.trim();
  const basYm = monthInput.value.trim();
  if (!key) return setNotice('공공데이터포털에서 발급받은 서비스키를 입력해 주세요.', 'error');
  if (!/^\d{6}$/.test(basYm)) return setNotice('기준년월은 YYYYMM 형식의 숫자 6자리여야 합니다.', 'error');

  loadButton.disabled = true;
  loadButton.textContent = '조회 중…';
  setNotice('금융위원회 API에서 재무현황·주요경영지표·주요영업활동을 조회하고 있습니다.', 'info');
  try {
    const settled = await Promise.allSettled(DATASETS.map(dataset => loadEndpoint(dataset, key, basYm)));
    const failed = settled.filter(result => result.status === 'rejected');
    const groups = Object.fromEntries(DATASETS.map((dataset, index) => [dataset.group, settled[index].status === 'fulfilled' ? settled[index].value : []]));
    const companies = mergeByCompany(groups, basYm);
    if (!companies.length && failed.length) throw failed[0].reason;
    renderTable(companies);
    renderChart(companies);
    document.querySelector('#companyCount').textContent = `${companies.length}개사`;
    document.querySelector('#summaryMonth').textContent = basYm;
    document.querySelector('#dataState').textContent = companies.length ? '조회 완료' : '응답 없음';
    const message = companies.length
      ? `${companies.length}개 카드사의 실제 API 응답을 표시했습니다.${failed.length ? ' 일부 API 요청은 일시 오류로 누락됐습니다.' : ''}`
      : 'API 응답은 성공했지만, 해당 기준년월에 비교 가능한 항목이 없습니다.';
    setNotice(message, companies.length ? 'success' : 'info');
    if (companies.length) loadHistory();
  } catch (error) {
    document.querySelector('#dataState').textContent = '조회 오류';
    setNotice(`API 조회 오류: ${error.message}. 서비스키의 활용신청 상태와 기준년월을 확인해 주세요.`, 'error');
  } finally {
    loadButton.disabled = false;
    loadButton.textContent = '실제 데이터 조회';
  }
}

loadButton.addEventListener('click', loadData);
monthInput.addEventListener('keydown', event => { if (event.key === 'Enter') loadData(); });
historyButton.addEventListener('click', loadHistory);
companyFilters.addEventListener('change', renderHistoryChart);
