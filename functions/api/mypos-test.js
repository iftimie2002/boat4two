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
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "GOOGLE_CALENDAR_ID",
    "MYPOS_SID",
    "MYPOS_KEY_INDEX",
    "MYPOS_PRIVATE_KEY",
    "MYPOS_PUBLIC_CERT"
  ];
  const optional = [
    "MYPOS_CHECKOUT_URL",
    "MYPOS_SUCCESS_URL",
    "MYPOS_CANCEL_URL",
    "MYPOS_CLIENT_ID",
    "MYPOS_CLIENT_SECRET"
  ];
  const walletAliases = [
    "MYPOS_WALLET_NUMBER",
    "MYPOS_CLIENT_NUMBER"
  ];
  const loaded = {};

  for (const name of required) {
    loaded[name] = Boolean(env[name]);
  }

  for (const name of optional) {
    loaded[name] = Boolean(env[name]);
  }

  for (const name of walletAliases) {
    loaded[name] = Boolean(env[name]);
  }

  const missing = required.filter((name) => !env[name]);
  const hasWalletNumber = walletAliases.some((name) => Boolean(env[name]));

  if (!hasWalletNumber) {
    missing.push("MYPOS_WALLET_NUMBER");
  }

  return json({
    ok: missing.length === 0,
    loaded,
    missing,
    checkoutUrl: env.MYPOS_CHECKOUT_URL || "https://www.mypos.eu/vmp/checkout",
    usingWalletVariable: env.MYPOS_WALLET_NUMBER
      ? "MYPOS_WALLET_NUMBER"
      : (env.MYPOS_CLIENT_NUMBER ? "MYPOS_CLIENT_NUMBER" : null),
    message: missing.length === 0
      ? "Google and myPOS environment variables are loaded."
      : `Missing environment variables: ${missing.join(", ")}.`
  });
}
