export const FUND_THEME_MODULES = [
  "存储芯片",
  "创新药",
  "恒生科技",
  "食品饮料",
  "白酒",
  "医药",
  "汽车整车",
  "房地产",
  "农林牧渔",
  "医疗",
  "金融科技",
  "沪港深消费",
  "脑机接口",
  "养老产业",
  "创业板",
  "恒生",
  "货币基金",
  "红利低波",
  "债基",
  "可转债",
  "混债",
  "量化",
  "固态电池",
  "海外医药",
  "低空经济",
  "双创50",
  "储能",
  "上证50",
  "传媒游戏",
  "CPO",
  "沪深300",
  "大科技",
  "证券保险",
  "标普",
  "小微盘量化",
  "半导体",
  "军工",
  "油气资源",
  "红利",
  "北证",
  "蓝筹",
  "港股红利",
  "先进制造",
  "消费电子",
  "通信",
  "科创板",
  "微盘股",
  "家用电器",
  "AI应用",
  "新能源",
  "云计算",
  "交通运输",
  "中证500",
  "人工智能",
  "半导体材料设备",
  "黄金",
  "现金流",
  "亚太",
  "商业航天",
  "机器人",
  "煤炭",
  "锂矿",
  "基建",
  "电力",
  "电网设备",
  "可控核聚变",
  "化工",
  "稀土永磁",
  "有色金属",
  "钢铁",
  "黄金股",
] as const;

export type FundThemeModule = (typeof FUND_THEME_MODULES)[number];

export function uniqStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
