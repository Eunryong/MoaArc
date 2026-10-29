import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
} from "react";
import en, { type I18nKeys } from "./en";
import ko from "./ko";

type Lang = "en" | "ko";
const STORAGE_KEY = "moaarc.lang";

const dicts: Record<Lang, Record<I18nKeys, string>> = { en, ko };

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: I18nKeys, params?: Record<string, string | number>) => string;
  fmtUsdc: (raw: bigint, decimals?: number) => string;
}

const Ctx = createContext<I18nCtx | null>(null);

function interpolate(s: string, params?: Record<string, string | number>) {
  if (!params) return s;
  return s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v: string | number | undefined = params[k];
    return v !== undefined ? String(v) : `{{${k}}}`;
  });
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "ko" ? "ko" : "en";
  });

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem(STORAGE_KEY, l);
    document.documentElement.lang = l;
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useCallback(
    (key: I18nKeys, params?: Record<string, string | number>) =>
      interpolate(dicts[lang][key] ?? dicts.en[key] ?? key, params),
    [lang],
  );

  // Format USDC amount — en: "12.50 USDC", ko: "12.50 USDC" (same for now, room to diverge)
  const fmtUsdc = useCallback(
    (raw: bigint, decimals = 6) => {
      const num = Number(raw) / 10 ** decimals;
      return `${num.toFixed(2)} USDC`;
    },
    [],
  );

  return <Ctx.Provider value={{ lang, setLang, t, fmtUsdc }}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}


