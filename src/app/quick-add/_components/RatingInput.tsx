"use client";

type Props = {
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
};

export default function RatingInput({ value, onChange, disabled }: Props) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={disabled}
          onClick={() => onChange(value === star ? null : star)}
          className={[
            "text-xl leading-none transition-colors",
            disabled ? "cursor-not-allowed opacity-40" : "hover:text-yellow-400",
            (value ?? 0) >= star ? "text-yellow-400" : "text-zinc-300",
          ].join(" ")}
          aria-label={`${star}星`}
        >
          ★
        </button>
      ))}
      {value !== null && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange(null)}
          className="ml-1 text-xs text-zinc-400 hover:text-zinc-600 disabled:opacity-40"
        >
          クリア
        </button>
      )}
    </div>
  );
}
