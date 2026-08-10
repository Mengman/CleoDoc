import type { EmbeddingLanguage } from "../../../../packages/rag/src/index.js";

export interface BenchmarkDocument {
  readonly key: string;
  readonly title: string;
  readonly content: string;
}

export interface BenchmarkQuery {
  readonly text: string;
  readonly expectedDocumentKey: string;
}

interface BenchmarkCorpus {
  readonly documents: readonly BenchmarkDocument[];
  readonly queries: readonly BenchmarkQuery[];
}

export function corpusFor(language: EmbeddingLanguage): BenchmarkCorpus {
  return language === "zh" ? CHINESE_CORPUS : ENGLISH_CORPUS;
}

const CHINESE_CORPUS: BenchmarkCorpus = {
  documents: [
    {
      key: "city-gate",
      title: "城门值守记录",
      content: "守城士兵每天深夜封闭城门，核对通行凭证后才允许旅人进出城市。",
    },
    {
      key: "railway-lighting",
      title: "铁路照明记录",
      content: "蒸汽列车抵达小站时，站务员会点亮煤油灯，为夜班列车照明并检查信号。",
    },
    {
      key: "medical-treatment",
      title: "诊疗记录",
      content: "医生确认患者受到细菌感染后使用青霉素治疗，并持续观察体温和伤口变化。",
    },
    {
      key: "village-water",
      title: "村庄供水记录",
      content: "旱季河流干涸以后，村民从山脚的深井提取饮用水，再运送到各户储存。",
    },
    {
      key: "observatory",
      title: "天文台记录",
      content: "天文学家使用射电望远镜接收遥远星系的信号，研究恒星诞生和宇宙演化。",
    },
    {
      key: "merchant-credit",
      title: "商会信用记录",
      content: "商人凭借仓单向银行申请短期贷款，以便在货物售出以前支付运输费用。",
    },
  ],
  queries: [
    { text: "夜间什么时候停止人员从城市入口通行？", expectedDocumentKey: "city-gate" },
    { text: "火车站怎样为深夜到达的车辆提供光线？", expectedDocumentKey: "railway-lighting" },
    { text: "患者感染以后使用了哪一种抗生素？", expectedDocumentKey: "medical-treatment" },
    { text: "河水枯竭时居民从哪里取得饮用水？", expectedDocumentKey: "village-water" },
  ],
};

const ENGLISH_CORPUS: BenchmarkCorpus = {
  documents: [
    {
      key: "city-gate",
      title: "City gate record",
      content:
        "The guards close the city gate late every night and inspect travel permits before allowing anyone to enter or leave.",
    },
    {
      key: "railway-lighting",
      title: "Railway lighting record",
      content:
        "When the steam train reaches the rural station, workers light kerosene lamps for the night service and inspect the signals.",
    },
    {
      key: "medical-treatment",
      title: "Medical record",
      content:
        "After confirming a bacterial infection, the physician treats the patient with penicillin and monitors the fever and wound.",
    },
    {
      key: "village-water",
      title: "Village water record",
      content:
        "When the river dries during the drought, villagers draw drinking water from a deep well near the mountain and carry it home.",
    },
    {
      key: "observatory",
      title: "Observatory record",
      content:
        "Astronomers use a radio telescope to receive signals from distant galaxies and study the formation of stars.",
    },
    {
      key: "merchant-credit",
      title: "Merchant credit record",
      content:
        "The merchant uses warehouse receipts to obtain a short-term bank loan and pay transport costs before the goods are sold.",
    },
  ],
  queries: [
    {
      text: "When is passage through the town entrance stopped?",
      expectedDocumentKey: "city-gate",
    },
    {
      text: "How does the station illuminate trains arriving after dark?",
      expectedDocumentKey: "railway-lighting",
    },
    {
      text: "Which antibiotic is given for the infection?",
      expectedDocumentKey: "medical-treatment",
    },
    {
      text: "Where do residents obtain drinking water after the river dries?",
      expectedDocumentKey: "village-water",
    },
  ],
};
