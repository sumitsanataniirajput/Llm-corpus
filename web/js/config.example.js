// ---------------------------------------------------------------------------
// COPY THIS FILE to  js/config.js  and fill in your own values.
// Everything here is PUBLIC by design (it is downloaded by the browser).
// NEVER put the Supabase "service_role" key, Razorpay secret, SMS keys or any
// other secret in this file. Secrets belong in Supabase Edge Function secrets.
// ---------------------------------------------------------------------------
window.RMS_CONFIG = {
  // Supabase Dashboard > Project Settings > API
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",

  // Google Cloud Console > Maps JavaScript API key, restricted to your website (HTTP referrer).
  // Leave "" to run without maps: map screens will say so and show table views instead.
  GOOGLE_MAPS_API_KEY: "",
  // Optional Map ID (Google Cloud > Map Management). Leave "" for the default style.
  GOOGLE_MAPS_MAP_ID: "",

  // Firebase web push (optional). Leave null to use in-app notifications only.
  // Firebase Console > Project settings > General > Your apps > Web app.
  FIREBASE: null,
  // Example:
  // FIREBASE: { apiKey: "", authDomain: "", projectId: "", messagingSenderId: "", appId: "" },
  FIREBASE_VAPID_KEY: "",

  // Shown as a badge in the sidebar so nobody confuses test and live. "production" hides it.
  ENVIRONMENT: "development"
};
