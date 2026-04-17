function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

export async function onRequestGet(context) {
  const { env } = context;

  const hasClientId = Boolean(env.MYPOS_CLIENT_ID);
  const hasClientSecret = Boolean(env.MYPOS_CLIENT_SECRET);

  return json({
    ok: hasClientId && hasClientSecret,
    myposClientIdLoaded: hasClientId,
    myposClientSecretLoaded: hasClientSecret,
    message: hasClientId && hasClientSecret
      ? "myPOS credentials are loaded in Cloudflare."
      : "Missing myPOS credentials in Cloudflare."
  });
}
