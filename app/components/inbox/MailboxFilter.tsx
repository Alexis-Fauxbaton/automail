import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import type { MailConnection } from "@prisma/client";

export default function MailboxFilter(props: {
  connections: Pick<MailConnection, "id" | "email">[];
  countsByMailbox: Record<string, number>;
  totalCount: number;
}) {
  const { connections, countsByMailbox, totalCount } = props;
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation();

  if (connections.length <= 1) return null;

  const current = searchParams.get("mailbox") || "";

  const selectStyle: React.CSSProperties = {
    padding: "6px 8px",
    borderRadius: 6,
    border: "1px solid var(--p-color-border, #d0d0d0)",
    background: "white",
    font: "inherit",
  };

  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        font: "inherit",
        fontSize: 12,
        color: "var(--p-color-text-subdued, #6d7175)",
      }}
    >
      {t("inbox.mailboxFilterLabel", { defaultValue: "Boîte" })}
      <select
        value={current}
        onChange={(e) => {
          const next = new URLSearchParams(searchParams);
          if (e.target.value) next.set("mailbox", e.target.value);
          else next.delete("mailbox");
          setSearchParams(next);
        }}
        style={selectStyle}
      >
        <option value="">
          {t("inbox.allMailboxes", { count: totalCount })}
        </option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.email} ({countsByMailbox[c.id] ?? 0})
          </option>
        ))}
      </select>
    </label>
  );
}
