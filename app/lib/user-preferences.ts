import prisma from "../db.server";

const VALID_LANGS = ["fr", "en"] as const;
type UiLanguage = (typeof VALID_LANGS)[number];

function sanitize(lang: string): UiLanguage {
  return (VALID_LANGS as readonly string[]).includes(lang) ? (lang as UiLanguage) : "en";
}

export async function getUiLanguage(userId: string, shop: string): Promise<UiLanguage> {
  const pref = await prisma.userPreference.findUnique({
    where: { userId_shop: { userId, shop } },
    select: { uiLanguage: true },
  });
  return sanitize(pref?.uiLanguage ?? "en");
}

export async function saveUiLanguage(userId: string, shop: string, uiLanguage: string): Promise<void> {
  const lang = sanitize(uiLanguage);
  await prisma.userPreference.upsert({
    where: { userId_shop: { userId, shop } },
    update: { uiLanguage: lang },
    create: { userId, shop, uiLanguage: lang },
  });
}
