import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const headers: HeadersFunction = () => ({
  "Cache-Control": "no-store",
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    // Reconstruct `host` if missing — the SDK requires it for embedded auth.
    // After an OAuth callback, `host` is not in the redirect URL, so we
    // derive it from the shop subdomain (e.g. "2ed20e" from 2ed20e.myshopify.com).
    if (!url.searchParams.get("host")) {
      const shopId = shop.split(".")[0];
      const host = Buffer.from(
        `admin.shopify.com/store/${shopId}`
      ).toString("base64");
      url.searchParams.set("host", host);
    }
    throw redirect(`/app?${url.searchParams.toString()}`, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Automail</h1>
        <p className={styles.text}>
          Le copilote de support client pour boutiques Shopify. Automail analyse
          chaque email entrant, retrouve la commande concernée, vérifie le suivi
          colis et propose un brouillon de réponse vérifié, prêt à envoyer.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Domaine de la boutique</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="ma-boutique.myshopify.com"
              />
              <span>ex. : ma-boutique.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Se connecter
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Analyse intelligente</strong>. Détection automatique de
            l'intention support, extraction du numéro de commande et du client.
          </li>
          <li>
            <strong>Données vérifiées</strong>. Récupération en direct du statut
            de la commande, des fulfillments et du suivi de chaque colis.
          </li>
          <li>
            <strong>Brouillons prudents</strong>. Réponses générées à partir de
            faits vérifiés, jamais inventées — vous gardez toujours la main pour
            valider et envoyer.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="/privacy">Politique de confidentialité</a>
        </p>
      </div>
    </div>
  );
}
