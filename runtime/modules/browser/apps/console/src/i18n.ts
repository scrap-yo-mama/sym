// SPDX-License-Identifier: AGPL-3.0-only
// vue-i18n 11 (API Composition), langues `fr` et `en` (cdc/sym-browser 04d § 5.1) : clés `console.<écran>.<élément>`,
// français au tutoiement, langue choisie dans l'en-tête et mémorisée dans le navigateur. `en` fait foi pour la forme des
// messages ; la parité des clés est testée. Quand SYM parle, la signature (icône SVG et « SYM : ») est le composant
// SymSignature de packages/ui, jamais un emoji dans le texte. Aucune phrase du serveur n'est affichée : les codes d'erreur
// sont traduits ici.
import { createI18n } from 'vue-i18n';
import { screensEn, screensFr } from './i18n-screens.js';

export const LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const LOCALE_STORAGE_KEY = 'symb.console.locale';

const en = {
  console: {
    common: {
      product: 'Browser',
      skipToContent: 'Skip to content',
      language: 'Language',
      languages: { fr: 'Français', en: 'English' },
      signedInAs: 'Signed in as {email}',
      signOut: 'Sign out',
      loading: 'Loading…',
      titleSuffix: 'SYM Browser',
    },
    login: {
      title: 'Sign in to the console',
      description: 'Sign in with the admin account of this instance.',
      email: 'Email',
      password: 'Password',
      submit: 'Sign in',
      submitting: 'Signing in…',
      initialized: 'Your admin account is ready. Sign in to open the console.',
      totp: {
        title: 'Two-step verification',
        description: 'Enter the 6-digit code from your authenticator app.',
        code: 'Verification code',
        submit: 'Verify',
        submitting: 'Verifying…',
        cancel: 'Use another account',
      },
      errors: {
        invalid_credentials: 'Incorrect email or password.',
        invalid_code: 'This code is not valid. Check the time on your phone and try again.',
        rate_limited: 'Too many attempts. Wait a few minutes before trying again.',
        not_initialized: 'This instance has no admin yet. Finish the first start.',
        no_pending_login: 'Your sign-in has expired. Enter your email and password again.',
        session_expired: 'Your session has ended. Sign in again.',
        network: 'The server is not responding. Check your connection and try again.',
        unexpected: 'Something went wrong on our side. Try again in a moment.',
      },
    },
    setup: {
      title: 'First start',
      intro: 'Welcome! Paste the first-start token from the startup logs, then create your admin account.',
      token: 'First-start token',
      tokenHint: 'Printed once in the logs when SYM Browser first starts (SYMB_BOOTSTRAP_TOKEN).',
      email: 'Admin email',
      password: 'Password',
      passwordHint: 'At least 12 characters.',
      submit: 'Create the admin account',
      submitting: 'Creating…',
      errors: {
        invalid_bootstrap_token: 'This token is not valid or has already been used. No account was created.',
        already_initialized: 'An admin account already exists. Sign in instead.',
        weak_password: 'The password must have at least 12 characters. No account was created.',
        invalid_email: 'Enter a valid email address. No account was created.',
        rate_limited: 'Too many attempts. Wait a few minutes before trying again.',
        network: 'The server is not responding. Check your connection and try again.',
        unexpected: 'Something went wrong on our side. Try again in a moment.',
      },
    },
    ...screensEn,
    home: {
      ...screensEn.home,
      title: 'Home',
      welcome: 'Welcome back. Pick a section: sessions, nodes, keys, profiles or usage.',
    },
  },
};

type MessageSchema = typeof en;

const fr: MessageSchema = {
  console: {
    common: {
      product: 'Browser',
      skipToContent: 'Aller au contenu',
      language: 'Langue',
      languages: { fr: 'Français', en: 'English' },
      signedInAs: 'Compte connecté : {email}',
      signOut: 'Se déconnecter',
      loading: 'Chargement…',
      titleSuffix: 'SYM Browser',
    },
    login: {
      title: 'Connexion à la console',
      description: 'Connecte-toi avec le compte admin de cette instance.',
      email: 'E-mail',
      password: 'Mot de passe',
      submit: 'Se connecter',
      submitting: 'Connexion…',
      initialized: 'Ton compte admin est créé. Connecte-toi pour ouvrir la console.',
      totp: {
        title: 'Vérification en deux étapes',
        description: 'Saisis le code à 6 chiffres de ton application d’authentification.',
        code: 'Code de vérification',
        submit: 'Vérifier',
        submitting: 'Vérification…',
        cancel: 'Utiliser un autre compte',
      },
      errors: {
        invalid_credentials: 'E-mail ou mot de passe incorrect.',
        invalid_code: 'Ce code n’est pas valide. Vérifie l’heure de ton téléphone et réessaie.',
        rate_limited: 'Trop de tentatives. Attends quelques minutes avant de réessayer.',
        not_initialized: 'Cette instance n’a pas encore d’admin. Termine le premier démarrage.',
        no_pending_login: 'Ta connexion a expiré. Saisis à nouveau ton e-mail et ton mot de passe.',
        session_expired: 'Ta session est terminée. Connecte-toi à nouveau.',
        network: 'Le serveur ne répond pas. Vérifie ta connexion et réessaie.',
        unexpected: 'Un souci de notre côté. Réessaie dans un instant.',
      },
    },
    setup: {
      title: 'Premier démarrage',
      intro: 'Bienvenue ! Colle le jeton de premier démarrage affiché dans les journaux, puis crée ton compte admin.',
      token: 'Jeton de premier démarrage',
      tokenHint: 'Écrit une seule fois dans les journaux au premier lancement de SYM Browser (SYMB_BOOTSTRAP_TOKEN).',
      email: 'E-mail de l’admin',
      password: 'Mot de passe',
      passwordHint: '12 caractères au minimum.',
      submit: 'Créer le compte admin',
      submitting: 'Création…',
      errors: {
        invalid_bootstrap_token: 'Ce jeton n’est pas valide ou a déjà servi. Aucun compte n’a été créé.',
        already_initialized: 'Un compte admin existe déjà. Connecte-toi.',
        weak_password: 'Le mot de passe doit faire au moins 12 caractères. Aucun compte n’a été créé.',
        invalid_email: 'Saisis une adresse e-mail valide. Aucun compte n’a été créé.',
        rate_limited: 'Trop de tentatives. Attends quelques minutes avant de réessayer.',
        network: 'Le serveur ne répond pas. Vérifie ta connexion et réessaie.',
        unexpected: 'Un souci de notre côté. Réessaie dans un instant.',
      },
    },
    ...screensFr,
    home: {
      ...screensFr.home,
      title: 'Accueil',
      welcome: 'Te revoilà. Choisis une section : sessions, nœuds, clés, profils ou consommation.',
    },
  },
};

export const messages: Record<Locale, MessageSchema> = { fr, en };

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** `fr-CA` → `fr` ; toute autre langue → `en`. */
export function normalizeLocale(value: string | null | undefined): Locale {
  return value?.toLowerCase().startsWith('fr') === true ? 'fr' : 'en';
}

/** Langue initiale : choix mémorisé, sinon langue du navigateur, sinon `en`. */
export function detectLocale(stored: string | null, navigatorLanguage: string | undefined): Locale {
  return isLocale(stored) ? stored : normalizeLocale(navigatorLanguage);
}

/** Code d'erreur → clé de message de l'écran ; un code inconnu devient `unexpected` (jamais de texte brut du serveur). */
export function errorKey(screen: 'login' | 'setup', code: string): string {
  const known = messages.en.console[screen].errors as Record<string, string>;
  return `console.${screen}.errors.${Object.hasOwn(known, code) ? code : 'unexpected'}`;
}

/** Code d'erreur d'un écran (3.6) → message ; un code inconnu devient `unexpected` (jamais de texte brut du serveur). */
export function screenErrorKey(code: string): string {
  const known = messages.en.console.errors as Record<string, string>;
  return `console.errors.${code !== 'retry' && Object.hasOwn(known, code) ? code : 'unexpected'}`;
}

export function createConsoleI18n(locale: Locale) {
  return createI18n<[MessageSchema], Locale, false>({ legacy: false, locale, fallbackLocale: 'en', messages });
}
