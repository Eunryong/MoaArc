import type { ParticipantId, Participant } from "../types";

interface Props {
  participants: Participant[];
  currentUserId: ParticipantId;
  onSwitch: (id: ParticipantId) => void;
  isDemoMode?: boolean;
}

const ID_COLORS: Record<ParticipantId, string> = {
  A: "bg-indigo-100 text-indigo-800 border-indigo-200",
  B: "bg-emerald-100 text-emerald-800 border-emerald-200",
  C: "bg-amber-100 text-amber-800 border-amber-200",
  D: "bg-rose-100 text-rose-800 border-rose-200",
};

const ID_ACTIVE: Record<ParticipantId, string> = {
  A: "bg-indigo-600 text-white border-indigo-600",
  B: "bg-emerald-600 text-white border-emerald-600",
  C: "bg-amber-500 text-white border-amber-500",
  D: "bg-rose-600 text-white border-rose-600",
};

export default function UserSwitcher({ participants, currentUserId, onSwitch, isDemoMode }: Props) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-amber-600 font-medium tracking-wide">
        시연 역할 전환
      </span>
      {participants.map((p) => (
        <button
          key={p.id}
          onClick={() => onSwitch(p.id)}
          disabled={!isDemoMode}
          className={`px-3 py-1.5 rounded-full border text-xs font-semibold transition-all ${
            !isDemoMode
              ? "opacity-40 cursor-not-allowed bg-stone-100 text-stone-400 border-stone-200"
              : currentUserId === p.id
              ? ID_ACTIVE[p.id]
              : `${ID_COLORS[p.id]} hover:opacity-80`
          }`}
        >
          {p.id} · {p.name.split(" ")[0]}
          {p.isAdmin && (
            <span className="ml-1 opacity-70">(관리자)</span>
          )}
        </button>
      ))}
      {isDemoMode && (
        <span className="text-xs text-amber-500 ml-1">⚠️ 시연용</span>
      )}
    </div>
  );
}
