import { useEffect, useId, useRef, type RefObject } from "react";
import { useI18n } from "../i18n";
import type { BalanceDetails, DetailStatus } from "../balanceDetails";

interface Props {
  open: boolean;
  onClose: () => void;
  details: BalanceDetails;
  /** 닫을 때 포커스를 돌려줄 요소 (Details 버튼) */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** 상태에 따른 글자색: 값이 아닌 상태 문구(로딩/실패)는 숫자처럼 보이지 않게 구분 */
function statusClass(status: DetailStatus): string {
  if (status === "ok") return "text-stone-800";
  if (status === "error") return "text-rose-600";
  return "text-stone-400";
}

/**
 * 잔액 상세 대화상자 — role="dialog" + aria-modal, Esc/배경 클릭/닫기 버튼으로 닫힘,
 * 열릴 때 닫기 버튼으로 포커스 이동, Tab 포커스 순환, 닫으면 Details 버튼으로 포커스 복귀.
 * 모든 금액은 소수점 6자리 정확 표기이며 읽는 중/실패는 0 대신 상태 문구로 표시합니다.
 */
export default function BalanceDetailsDialog({ open, onClose, details, returnFocusRef }: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const introId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!open) return;
    const returnTo = returnFocusRef?.current ?? null;
    closeRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnTo?.focus();
    };
  }, [open, returnFocusRef]);

  if (!open) return null;

  const summaryRows: { id: string; label: string; value: string; status: DetailStatus }[] = [
    { id: "shared", label: t("shared_balance_now"), value: details.sharedBalance.text, status: details.sharedBalance.status },
    { id: "cumulative", label: t("total_deposited"), value: details.cumulativeDeposits.text, status: details.cumulativeDeposits.status },
    { id: "allocated", label: t("external_wallet_budget"), value: details.allocatedTotal.text, status: details.allocatedTotal.status },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={introId}
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-stone-100 p-4">
          <h2 id={titleId} className="text-base font-semibold text-stone-800">{t("details_title")}</h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-lg border border-stone-200 px-4 text-sm font-medium text-stone-700 hover:bg-stone-50"
          >
            {t("close_btn")}
          </button>
        </div>

        <div className="space-y-5 p-4">
          <p id={introId} className="text-xs text-stone-500">{t("details_intro")}</p>

          <section aria-labelledby={`${titleId}-summary`}>
            <h3 id={`${titleId}-summary`} className="mb-2 text-sm font-semibold text-stone-700">
              {t("details_summary_heading")}
            </h3>
            <dl className="divide-y divide-stone-100 rounded-xl border border-stone-200">
              {summaryRows.map((row) => (
                <div key={row.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <dt className="text-xs text-stone-500">{row.label}</dt>
                  <dd className={`text-sm font-semibold tabular-nums ${statusClass(row.status)}`}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby={`${titleId}-participants`}>
            <h3 id={`${titleId}-participants`} className="mb-2 text-sm font-semibold text-stone-700">
              {t("details_participants_heading")}
            </h3>
            <div
              className="overflow-x-auto rounded-xl border border-stone-200"
              role="region"
              aria-label={t("details_table_caption")}
              tabIndex={0}
            >
              <table className="w-full min-w-[560px] text-sm">
                <caption className="sr-only">{t("details_table_caption")}</caption>
                <thead>
                  <tr className="border-b border-stone-100 text-xs text-stone-500">
                    <th scope="col" className="px-3 py-2 text-left font-medium">{t("details_col_wallet")}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">{t("details_col_allocated")}</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">{t("details_col_spent")}</th>
                  </tr>
                </thead>
                <tbody>
                  {details.participants.map((p) => (
                    <tr key={p.key} className={`border-b border-stone-50 last:border-0 ${p.isMe ? "bg-indigo-50/40" : ""}`}>
                      <th scope="row" className="px-3 py-2 text-left font-normal align-top">
                        <span className="font-medium text-stone-800">{p.name}</span>
                        {p.isMe && <span className="ml-1 text-xs text-indigo-600">({t("me")})</span>}
                        {/* 이름이 같은 참여자도 전체 주소로 구분 */}
                        <span
                          className={`block break-all font-mono text-xs ${p.hasDuplicateName ? "text-stone-700" : "text-stone-400"}`}
                          title={p.address}
                        >
                          {p.address}
                        </span>
                      </th>
                      <td className={`px-3 py-2 text-right align-top tabular-nums ${statusClass(p.allocated.status)}`}>{p.allocated.text}</td>
                      <td className={`px-3 py-2 text-right align-top tabular-nums ${statusClass(p.spent.status)}`}>{p.spent.text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <p className="text-xs text-stone-400">{t("details_status_note")}</p>
        </div>
      </div>
    </div>
  );
}
