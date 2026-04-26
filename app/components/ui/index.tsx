/* eslint-disable react/no-unknown-property */
import type { CSSProperties, ReactNode, SVGProps } from "react";

// ---------------------------------------------------------------------------
// Tone shared by pills, metric icons, progress bars, etc.
// Mirrors the mockup's slate / blue / indigo / emerald / amber / rose palette.
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "info" | "primary" | "success" | "warning" | "danger";

// ---------------------------------------------------------------------------
// Icons — subset of the mockup's Lucide-style outline icons. Inline SVGs to
// avoid adding a runtime dependency.
// ---------------------------------------------------------------------------

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const InboxIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 13 6 5h12l2 8" />
    <path d="M3 13h5l2 3h4l2-3h5v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4Z" />
  </Icon>
);
export const MailIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m4 7 8 6 8-6" />
  </Icon>
);
export const SparklesIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7L12 3Z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" />
    <path d="M5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z" />
  </Icon>
);
export const CheckCircleIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);
export const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const TrendUpIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 16l5-5 4 4 7-7" />
    <path d="M20 8v5h-5" />
  </Icon>
);
export const ChartIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 19h16" />
    <path d="M7 16V9" />
    <path d="M12 16V5" />
    <path d="M17 16v-7" />
  </Icon>
);
export const StoreIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10V8l2-4h12l2 4v2" />
    <path d="M5 10h14v9H5z" />
    <path d="M9 19v-5h6v5" />
  </Icon>
);
export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v3" />
    <path d="M12 18v3" />
    <path d="M3 12h3" />
    <path d="M18 12h3" />
    <path d="m5.6 5.6 2.1 2.1" />
    <path d="m16.3 16.3 2.1 2.1" />
    <path d="m18.4 5.6-2.1 2.1" />
    <path d="m7.7 16.3-2.1 2.1" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
export const ShieldCheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3Z" />
    <path d="m9.5 12 1.8 1.8 3.2-3.3" />
  </Icon>
);
export const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4Z" />
  </Icon>
);
export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
export const RefreshIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 0 0-14.9-3M4 13a8 8 0 0 0 14.9 3" />
    <path d="M5 4v4h4M19 20v-4h-4" />
  </Icon>
);
export const UserIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Icon>
);
export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 5" />
    <path d="M14 11a5 5 0 0 0-7.07 0L5.52 12.4a5 5 0 0 0 7.07 7.07L14 18" />
  </Icon>
);

// ---------------------------------------------------------------------------
// Card — rounded-2xl wrapper with optional title/subtitle/eyebrow.
// ---------------------------------------------------------------------------

export function Card({
  title,
  subtitle,
  right,
  ghost,
  accentLeft,
  flush,
  style,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  ghost?: boolean;
  accentLeft?: boolean;
  flush?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const cls = [
    "ui-card",
    ghost && "ui-card--ghost",
    accentLeft && "ui-card--accent-left",
    flush && "ui-card--flush",
  ]
    .filter(Boolean)
    .join(" ");
  const showHeader = title || subtitle || right;
  return (
    <div className={cls} style={style}>
      {showHeader && (
        <div className="ui-card__header">
          <div>
            {title && <h3 className="ui-card__title">{title}</h3>}
            {subtitle && <p className="ui-card__subtitle">{subtitle}</p>}
          </div>
          {right && <div>{right}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pill — small status badge.
// ---------------------------------------------------------------------------

export function Pill({
  children,
  tone = "neutral",
  icon,
}: {
  children: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
}) {
  const cls = ["ui-pill", tone !== "neutral" && `ui-pill--${tone}`].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      {icon}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MetricCard — KPI tile with icon, value, label and helper.
// ---------------------------------------------------------------------------

export function MetricCard({
  label,
  value,
  helper,
  helperTone,
  icon,
  iconTone = "neutral",
  badge,
}: {
  label: string;
  value: ReactNode;
  helper?: ReactNode;
  helperTone?: "up" | "down" | "neutral";
  icon?: ReactNode;
  iconTone?: Tone;
  badge?: ReactNode;
}) {
  const helperCls = [
    "ui-metric__helper",
    helperTone === "up" && "ui-metric__helper--up",
    helperTone === "down" && "ui-metric__helper--down",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="ui-metric">
      <div className="ui-metric__top">
        {icon && (
          <div className={`ui-metric__icon ui-metric__icon--${iconTone}`}>{icon}</div>
        )}
        {badge}
      </div>
      <div className="ui-metric__value">{value}</div>
      <div className="ui-metric__label">{label}</div>
      {helper && <div className={helperCls}>{helper}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProgressRow — labelled progress bar.
// ---------------------------------------------------------------------------

export function ProgressRow({
  label,
  helper,
  value,
  tone = "primary",
}: {
  label: ReactNode;
  helper?: ReactNode;
  value: number;
  tone?: "info" | "primary" | "success" | "warning" | "danger";
}) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div>
      <div className="ui-progress__head">
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--ui-slate-900)" }}>{label}</div>
          {helper && <div style={{ fontSize: 12, color: "var(--ui-slate-500)" }}>{helper}</div>}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ui-slate-900)" }}>{clamped}%</div>
      </div>
      <div className="ui-progress__bar">
        <div className={`ui-progress__fill ui-progress__fill--${tone}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatRow — label + value with optional colored dot.
// ---------------------------------------------------------------------------

export function StatRow({
  label,
  value,
  dotColor,
}: {
  label: ReactNode;
  value: ReactNode;
  dotColor?: string;
}) {
  return (
    <div className="ui-statrow">
      <span className="ui-statrow__label">
        {dotColor && (
          <span className="ui-statrow__dot" style={{ background: dotColor }} aria-hidden="true" />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
      </span>
      <span className="ui-statrow__value">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SegmentedTabs — inbox-style status tab bar.
// ---------------------------------------------------------------------------

export function SegmentedTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<{ key: T; label: string; count?: number }>;
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="ui-tabs">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            className={`ui-tab${isActive ? " ui-tab--active" : ""}`}
            onClick={() => onChange(t.key)}
          >
            {t.label}
            {typeof t.count === "number" && <span className="ui-tab__count">{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
