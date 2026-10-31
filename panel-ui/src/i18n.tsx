import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Language = "en" | "zh";

const messages = {
  en: {
    appTitle: "XTNA investigation panel",
    generated: "generated",
    records: "records",
    artifacts: "artifacts",
    unknowns: "unknowns",
    limitations: "limitations",
    symbols: "symbols",
    hypotheses: "hypotheses",
    checkpoints: "checkpoints",
    topology: "Topology",
    waterfall: "Network waterfall",
    providerQuery: "Provider query",
    evidenceCards: "Evidence cards",
    queryDisabled:
      "Disabled. Start the panel with --mcp-url and --query-token.",
    queryHint:
      "Read-only allowlist; write tools need --allow-write-tools plus a terminal approval code.",
    token: "x-xtna-token",
    approvalCode: "approval code (if pending)",
    value: "value",
    query: "Query",
    running: "running…",
    ok: "ok",
    rejected: "rejected",
    approvePending: "approve in the panel terminal, then paste the code",
    noGraph: "No call-graph records in this bundle.",
    noWaterfall: "No network transactions in this bundle.",
    noTimings: "no timings recorded, order only",
    truncatedNodes: "truncated at 400 nodes / 1,200 edges",
    truncatedTransactions: "truncated at 200 transactions",
    loading: "Loading the investigation…",
    stateError: "Cannot read the panel state",
    settings: "Model settings",
    language: "Language",
    save: "Save",
    close: "Close",
    baseUrl: "Base URL (OpenAI-compatible)",
    apiKey: "API key",
    model: "Model id",
    apiStyle: "API style",
    settingsHint:
      "Saving restarts the local chat runtime with these values. The key stays on this machine.",
    saved: "Saved. Runtime is restarting.",
    keyStored: "A key is already stored; leave blank to keep it.",
  },
  zh: {
    appTitle: "XTNA 调查面板",
    generated: "生成于",
    records: "记录",
    artifacts: "产物",
    unknowns: "未知",
    limitations: "限制",
    symbols: "符号",
    hypotheses: "假设",
    checkpoints: "检查点",
    topology: "拓扑",
    waterfall: "网络瀑布",
    providerQuery: "Provider 查询",
    evidenceCards: "证据卡片",
    queryDisabled: "未启用。启动面板时加 --mcp-url 与 --query-token。",
    queryHint:
      "只读白名单；写工具需要 --allow-write-tools，并在终端确认批准码。",
    token: "x-xtna-token",
    approvalCode: "批准码（如已挂起）",
    value: "参数值",
    query: "查询",
    running: "执行中…",
    ok: "成功",
    rejected: "被拒",
    approvePending: "在面板终端确认，然后填入批准码",
    noGraph: "此证据包没有调用图记录。",
    noWaterfall: "此证据包没有网络事务。",
    noTimings: "未记录时间，仅按顺序",
    truncatedNodes: "已截断：400 节点 / 1,200 边",
    truncatedTransactions: "已截断：200 条事务",
    loading: "正在加载调查…",
    stateError: "无法读取面板状态",
    settings: "模型设置",
    language: "语言",
    save: "保存",
    close: "关闭",
    baseUrl: "Base URL（OpenAI 兼容）",
    apiKey: "API Key",
    model: "模型 ID",
    apiStyle: "接口风格",
    settingsHint: "保存后会重启本地聊天运行时；密钥只留在本机。",
    saved: "已保存，运行时正在重启。",
    keyStored: "已有保存的密钥；留空表示不修改。",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];

interface I18nValue {
  readonly language: Language;
  readonly setLanguage: (language: Language) => void;
  readonly t: (key: MessageKey) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

const storedLanguage = (): Language => {
  const value = localStorage.getItem("xtna.panel.language");
  return value === "zh" ? "zh" : "en";
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(storedLanguage);
  useEffect(() => {
    localStorage.setItem("xtna.panel.language", language);
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  }, [language]);
  const value = useMemo<I18nValue>(
    () => ({
      language,
      setLanguage,
      t: (key) => messages[language][key] ?? messages.en[key],
    }),
    [language],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = (): I18nValue => {
  const value = useContext(I18nContext);
  if (value === null) throw new Error("useI18n outside I18nProvider");
  return value;
};
