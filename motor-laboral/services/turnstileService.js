// Verificacion de Cloudflare Turnstile (Fase 11) -- unica proteccion
// anti-bot de todo el proyecto (no existia ninguna antes de esta fase,
// confirmado por grep). Mismo criterio que mercadopagoService.js: fetch
// nativo en vez de sumar una libreria/SDK nueva, y fetchImpl inyectable
// para poder testear sin pegarle a Cloudflare de verdad.
//
// Referencia: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

async function verifyTurnstileToken({ token, remoteIp, secretKey, fetchImpl = fetch }) {
  if (!token) return { success: false, errorCodes: ['missing-input-response'] };

  const body = new URLSearchParams();
  body.set('secret', secretKey);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);

  const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body });
  const json = await res.json();
  return { success: !!json.success, errorCodes: json['error-codes'] || [] };
}

module.exports = { verifyTurnstileToken };
