const fs = require('fs');

const newCards = [
  {
    category: 'fsd',
    categoryLabel: 'FSD · 자율·로보택시',
    time: '1h ago',
    pubDate: '2026-06-17T11:42:55.000Z',
    title: '텍사스 교통부 관료, 테슬라 사이버캡 <em>강력 지지</em> 공개 표명',
    hotShort: '텍사스 교통부, 사이버캡에 <em>강력 지지</em> 표명',
    body: '텍사스 교통부(TxDOT) 관료가 테슬라 사이버캡에 대한 강력한 지지 입장을 공개적으로 밝혔다고 테슬라라티가 보도했다 — 의회·주정부 규제 압박이 가중되는 시점에서, 테슬라 본사 소재지인 텍사스 교통당국의 공개 지지는 사이버캡 상용화 경로의 핵심 거점 확보 신호다.',
    sourceName: 'Teslarati',
    sourceLabel: 'press',
    slug: 'fsd-cybercab-texas-dot-support-2026-06-17',
    summary: '텍사스 교통부(Texas Department of Transportation, TxDOT)의 관료가 테슬라 사이버캡에 대해 강력한 지지를 공개적으로 표명했다고 테슬라라티가 보도했다. 텍사스는 테슬라 기가팩토리(기가텍사스)와 본사가 위치한 주로, 사이버캡 초기 상용화 거점으로 유력하게 거론되는 시장이다.\n\n이번 지지 표명은 FSD 규제 압박이 다방면에서 동시에 가중되는 시점에 나왔다. 미국 의회는 FSD 안전 데이터 공식 검토를 요청하고, 뉴저지주는 로보택시를 사실상 차단하는 법안을 심의하는 등 주·연방 차원 모두에서 자율주행 감독 의제가 확대되고 있다. 이런 환경에서 텍사스 교통당국의 공개 지지는 테슬라에게 본거지에서의 규제 우군을 확보한 것으로 읽힌다.\n\n텍사스는 자율주행 관련 입법에서 미국 내에서도 상대적으로 개방적인 규제 프레임워크를 유지해온 주다. 주 교통부 관료의 공식 지지가 실제 운영 허가·인프라 협력으로 구체화된다면, 텍사스는 사이버캡이 대규모 배차를 실현하고 전국 확산 모델을 만들어가는 선도 시장이 될 수 있다.\n\n테슬라 주주에게 이번 보도는 단기 재무 이벤트가 아닌 사이버캡 상용화 타임라인의 확실성을 높이는 중기 긍정 신호다. 지역·주·연방 인허가가 복합적으로 얽힌 로보택시 규제 지형에서, 핵심 거점 주의 교통당국이 공개적으로 테슬라 편에 서는 것은 이 그림의 중요한 한 칸을 채운다.',
    title_en: 'Texas DOT official gives Tesla Cybercab a <em>huge show of support</em>',
    hotShort_en: 'Texas DOT officially <em>backs Cybercab</em>',
    body_en: "A Texas Department of Transportation official has publicly expressed strong support for Tesla's Cybercab, Teslarati reports — a significant regulatory endorsement from Tesla's home state at a moment when federal lawmakers and other states are intensifying scrutiny of the robotaxi program.",
    summary_en: "A Texas Department of Transportation official has issued a strong public endorsement of Tesla's Cybercab, according to Teslarati. Texas is Tesla's corporate home state — the location of Gigafactory Texas in Austin — and is widely considered a leading candidate for Cybercab's first large-scale commercial deployment markets.\n\nThe timing of this endorsement is notable. On the same day, U.S. congressional lawmakers formally requested a federal review of Tesla's FSD safety data, and New Jersey's legislature was debating a bill that could effectively block Robotaxi operations in that state. Against that backdrop of mounting regulatory pressure, a public statement of support from Texas's transportation authority represents a meaningful counterweight in the regulatory narrative.\n\nTexas has historically maintained a relatively permissive posture on autonomous vehicle regulation — one of the more AV-friendly state regulatory environments in the country. A public endorsement from TxDOT suggests Tesla's regulatory relationship in its home state is on constructive footing. If this official support translates into formal permitting cooperation and infrastructure coordination, Texas could become the first market where Cybercab achieves large-scale deployment and establishes a national expansion playbook.\n\nFor Tesla shareholders, this is a mid-term confidence signal rather than a near-term financial event. Cybercab commercialization requires clearing layered approvals across municipal, state, and federal levels. A public endorsement from the state transportation authority in Tesla's home state meaningfully reduces one layer of that uncertainty and keeps the Texas Cybercab timeline on track.",
    href: 'https://www.teslarati.com/tesla-cybercab-gets-huge-nod-support-texas-dot-official/',
    sentiment: 'bull',
    hot: 7
  },
  {
    category: 'musk',
    categoryLabel: 'ELON · 일론 소식',
    time: '2h ago',
    pubDate: '2026-06-17T11:13:40.000Z',
    title: '블룸버그 "SpaceX 초기 VC들, 잠금 해제 후 <em>구주 매각 시점</em> 저울질"',
    hotShort: 'SpaceX VC들, 잠금 해제 후 <em>구주 매각</em> 논의',
    body: '블룸버그가 SpaceX IPO 이후 초기 벤처캐피털 투자자들이 잠금 기간(lock-up) 해제 후 보유 구주 매각 전략을 내부적으로 저울질하고 있다고 보도했다 — 상장 이후 +49% 급등한 SpaceX 주가로 초기 투자자들의 평가 차익이 크게 불어난 상황에서, 대규모 구주 물량이 시장에 출회될 경우 SpaceX 주가에 중기 수급 부담이 될 수 있다.',
    sourceName: 'Bloomberg.com',
    sourceLabel: 'press',
    slug: 'musk-spacex-lockup-debate-2026-06-17',
    summary: '블룸버그가 SpaceX의 나스닥 상장(2026년 6월 13일) 이후 초기 벤처캐피털(VC) 투자자들이 잠금 기간(lock-up period) 해제 후 구주 매각 전략을 내부적으로 논의하고 있다고 보도했다. IPO 잠금 기간은 대주주·내부자·초기 투자자의 주식 매도를 일정 기간 제한하며, 기간이 끝나면 시장에 대규모 구주 물량이 출회될 수 있다.\n\nSpaceX는 IPO 이후 단 3일 만에 +49% 랠리를 기록했다. IPO 가격 대비 이미 큰 차익이 발생한 상태에서, 초기 VC 투자자들이 잠금 해제 후 차익 실현 여부와 시점을 저울질하는 것은 자연스러운 수순이다. 블룸버그 보도는 이 논의가 SpaceX VC 커뮤니티에서 실제로 진행 중임을 확인한다.\n\n테슬라 주주 관점에서 SpaceX 구주 매각 논의는 간접적 관련성을 갖는다. 잠금 해제 후 대규모 구주 매각이 현실화되면 SpaceX 주가의 중기 수급에 부담을 줄 수 있으며, 이는 SpaceX IPO 랠리를 배경으로 높아진 머스크 생태계 전반의 투자 심리에 간접 영향을 미칠 수 있다. 다만 매각 규모·시점은 각 VC의 개별 판단에 달려 있으며, 현재로선 논의 단계임을 블룸버그도 명확히 한다.\n\n일론 머스크는 창업자로서 일반 잠금 기간 대상이 아니므로, 이번 논의는 외부 VC 투자자에 국한된다. 머스크의 SpaceX 지분과 자원 배분 전략에는 단기 변화가 없을 전망이다.',
    title_en: 'Bloomberg: SpaceX venture backers debate <em>when to cash out</em> as lockups expire',
    hotShort_en: 'SpaceX VCs weigh <em>post-lockup cash-out</em>',
    body_en: "Bloomberg reports that SpaceX's early venture capital investors are debating when to sell their holdings as IPO lockup periods expire — with the stock surging +49% since its June 13 Nasdaq debut, early backers are sitting on substantial gains and weighing exit timing, a dynamic that could generate meaningful supply pressure on SpaceX shares over the medium term.",
    summary_en: "Following SpaceX's landmark Nasdaq debut on June 13, 2026, Bloomberg reports that early venture capital investors are internally debating when to exit their positions as IPO lockup periods expire. IPO lockup agreements restrict major shareholders, insiders, and early backers from selling shares during an initial post-IPO period — once those lockups expire, significant blocks of stock become available to trade, potentially creating supply pressure.\n\nSpaceX surged +49% in the days following its IPO, surpassing both Microsoft and Amazon in market capitalization. For early VC investors who entered at valuations far below the IPO price, the post-debut rally has produced substantial paper gains. Bloomberg's report confirms that exit strategy discussions — when and how much to sell — are actively underway within the SpaceX VC investor community.\n\nFor Tesla shareholders, the SpaceX lockup dynamic is an indirect variable. If significant volumes of VC-held SpaceX shares come to market after lockup expiry, the resulting supply could moderate or partially reverse SpaceX's post-IPO gains. A meaningful pullback in SpaceX's stock would reduce the positive sentiment backdrop that the IPO rally has provided across the broader Musk ecosystem, including Tesla.\n\nElon Musk himself, as the company's founder, is not subject to standard VC lockup terms. Bloomberg's report specifically concerns the venture investor community, and how much selling actually occurs will depend on each fund's individual strategy and conviction. The near-term question is the timeframe and scale of lockup expirations — variables that will become clearer as SpaceX begins filing required SEC disclosures post-IPO.",
    href: 'https://www.bloomberg.com/news/newsletters/2026-06-17/spacex-venture-investors-debate-whether-to-cash-out-when-lockups-expire',
    sentiment: 'neutral',
    hot: 4
  },
  {
    category: 'stock',
    categoryLabel: 'STOCK · 주가·실적',
    time: '2h ago',
    pubDate: '2026-06-17T11:03:00.000Z',
    title: "배런스 \"아르헨티나 YPF 협력, 테슬라 <em>주가 회복 촉매 역부족</em>\"",
    hotShort: '배런스: YPF 협력, 테슬라 <em>주가 반전 역부족</em>',
    body: '배런스가 아르헨티나 국영 YPF와 테슬라의 EV 충전·에너지 저장 협력 탐색 소식이 최근 부진한 테슬라 주가를 반전시키기에는 역부족이라는 분석을 내놨다 — 협력이 탐색 초기 단계에 불과한 데다 직접 재무 영향이 제한적이어서, TSLA 주요 하방 압력을 상쇄하기에 부족하다는 논지다.',
    sourceName: "Barron's",
    sourceLabel: 'press',
    slug: 'stock-barrons-tsla-argentina-bearish-2026-06-17',
    summary: '배런스가 아르헨티나 국영 에너지 기업 YPF와 테슬라의 EV 충전·에너지 저장 협력 탐색 소식을 다루며, 이 딜이 현재의 테슬라 주가 흐름을 반전시킬 촉매로서는 역부족이라는 분석 기사를 게재했다.\n\n배런스의 핵심 논지는 협력의 단계와 규모에 있다. YPF-테슬라 협력은 현재 탐색(explore) 단계로, 구체적 계약 조건·투자 규모·배치 일정이 공개되지 않았다. 남미 에너지 기업과의 초기 협의가 TSLA의 보다 구조적인 과제들 — FSD 규제 불확실성, 마진 압박, 2분기 이후 수요 회복 속도 — 을 상쇄하기에는 충분하지 않다는 견해다.\n\n배런스는 다우존스 미디어 그룹 산하의 권위 있는 미국 금융 매거진으로, 테슬라에 대해 때로 비판적 시각을 내놓는다. 이번 분석은 아르헨티나 딜이 시장에서 필요 이상의 기대를 받는 것을 경계하는 논평이다.\n\n테슬라 주주 관점에서 배런스 기사는 아르헨티나 협력의 장기 전략 가치를 부정하는 것이 아니다. 협력이 탐색에서 실제 계약·배치 단계로 진전된다면 재평가가 이루어질 수 있다. 다만 현재로선 즉각적인 주가 상방 촉매보다 중장기 파이프라인으로 보는 것이 적절하다는 시각이 주류임을 이번 배런스 기사가 재확인하고 있다.',
    title_en: "Barron's: Argentina charger deal <em>won't reverse TSLA weakness</em>",
    hotShort_en: "Barron's: YPF deal <em>no TSLA catalyst</em>",
    body_en: "Barron's published a bearish note on Tesla stock, arguing the exploratory EV charging and energy storage collaboration between Argentina's state energy company YPF and Tesla is unlikely to serve as a catalyst for reversing TSLA's recent weakness — with the deal too early-stage and limited in scope to offset the structural headwinds weighing on the stock.",
    summary_en: "Barron's published a bearish analysis characterizing Tesla's newly announced exploratory collaboration with Argentina's state-owned YPF as insufficient to act as a meaningful catalyst for TSLA's stock recovery. The deal, as reported by Reuters, involves exploring EV charging infrastructure and energy storage cooperation, and remains at a preliminary exploratory stage with no formal agreement, investment scope, or deployment timeline disclosed.\n\nThe core of Barron's analysis centers on the deal's current stage and proportional relevance to TSLA's more consequential headwinds. An early-stage exploratory arrangement with a South American state energy company does not materially address the variables most directly weighing on TSLA: ongoing FSD regulatory scrutiny from both U.S. legislators and European authorities, margin pressure questions heading into Q2 earnings, and the pace of second-half 2026 delivery volume recovery.\n\nBarron's has historically maintained a skeptical lens on Tesla. The assessment here is consistent with a broader analytical framework in which TSLA's re-rating catalysts need to emerge from core business execution — delivery volumes, FSD commercialization, margin expansion — rather than from early-stage geographic partnerships in emerging markets.\n\nFor Tesla shareholders, the critique does not argue against the long-term strategic value of energy sector expansion in South America. The argument is specifically about near-term catalyst mechanics: the YPF deal, in its current exploratory form, is unlikely to provide the market signal needed to reverse near-term stock pressure. Whether that changes will depend on how quickly the collaboration advances to a formal, material agreement.",
    href: 'https://www.barrons.com/articles/tesla-stock-price-argentina-deal-11193c7f',
    sentiment: 'bear',
    hot: 5
  }
];

// ── cards.json ──
const existingCards = JSON.parse(fs.readFileSync('data/cards.json', 'utf8'));
const keepSlugs = ['musk-delaware-feud-corporate-law-2026-06-17', 'fsd-senators-fsd-safety-review-2026-06-16'];
const kept = existingCards.items.filter(c => keepSlugs.includes(c.slug));

const allCards = [...newCards, ...kept];
allCards.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

const cardsOut = {
  items: allCards,
  asOf: '2026-06-17 21:45 KST 자동 갱신 · 최신순'
};
fs.writeFileSync('data/cards.json', JSON.stringify(cardsOut, null, 2), 'utf8');
console.log('cards.json written:', allCards.length, 'cards');
allCards.forEach(c => console.log(' -', c.slug, '|', c.category, '| hot', c.hot));

// ── archive.json ──
const archive = JSON.parse(fs.readFileSync('data/archive.json', 'utf8'));
const existingItems = archive.items || [];
const existingSlugs = new Set(existingItems.map(c => c.slug));

const toAdd = newCards.filter(c => !existingSlugs.has(c.slug));
console.log('\nAdding to archive:', toAdd.map(c => c.slug));

const merged = [...toAdd, ...existingItems];
merged.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
const capped = merged.slice(0, 100);

const archiveOut = {
  items: capped,
  asOf: '2026-06-17 21:45 KST 자동 갱신 · 최신순'
};
fs.writeFileSync('data/archive.json', JSON.stringify(archiveOut, null, 2), 'utf8');
console.log('archive.json written:', capped.length, 'items (was', existingItems.length, ')');
