function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function normalizePemValue(pem) {
  let value = String(pem || "").trim();

  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return value
    .replace(/\\+\//g, "/")
    .replace(/\\+r\\+n|\\+n|\\+r/g, "\n")
    .replace(/\r\n|\r/g, "\n");
}

function summarizeInvalidBase64Characters(value) {
  const invalid = new Set();

  for (const char of value) {
    if (!/[A-Za-z0-9+/=]/.test(char)) {
      invalid.add(char === "\\" ? "\\\\" : char);
    }
  }

  return Array.from(invalid).slice(0, 8);
}

function diagnosePem(value, expectedLabels) {
  const raw = String(value || "");
  const normalized = normalizePemValue(raw);
  const labelMatch = normalized.match(/-----BEGIN ([^-]+)-----/);
  const label = labelMatch ? labelMatch[1] : "";
  const base64 = normalized
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const invalidBase64Characters = summarizeInvalidBase64Characters(base64);
  let base64Decodes = false;

  try {
    if (base64) {
      atob(base64);
      base64Decodes = true;
    }
  } catch {
    base64Decodes = false;
  }

  return {
    loaded: Boolean(raw),
    hasBeginLine: /-----BEGIN [^-]+-----/.test(normalized),
    hasEndLine: /-----END [^-]+-----/.test(normalized),
    label: label || null,
    labelExpected: Boolean(label && expectedLabels.includes(label)),
    hasEscapedNewlines: /\\+r\\+n|\\+n|\\+r/.test(raw),
    hasEscapedSlashes: /\\+\//.test(raw),
    normalizedLineCount: normalized ? normalized.split("\n").length : 0,
    hasBody: Boolean(base64),
    bodyLengthMultipleOf4: base64.length > 0 && base64.length % 4 === 0,
    invalidBase64Characters,
    base64Decodes
  };
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

  const pemDiagnostics = {
    MYPOS_PRIVATE_KEY: diagnosePem(env.MYPOS_PRIVATE_KEY, [
      "PRIVATE KEY",
      "RSA PRIVATE KEY"
    ]),
    MYPOS_PUBLIC_CERT: diagnosePem(env.MYPOS_PUBLIC_CERT, [
      "CERTIFICATE"
    ])
  };
  const pemReady = pemDiagnostics.MYPOS_PRIVATE_KEY.base64Decodes &&
    pemDiagnostics.MYPOS_PUBLIC_CERT.base64Decodes;
  const ok = missing.length === 0 && pemReady;

  return json({
    ok,
    loaded,
    missing,
    checkoutUrl: env.MYPOS_CHECKOUT_URL || "https://www.mypos.eu/vmp/checkout",
    usingWalletVariable: env.MYPOS_WALLET_NUMBER
      ? "MYPOS_WALLET_NUMBER"
      : (env.MYPOS_CLIENT_NUMBER ? "MYPOS_CLIENT_NUMBER" : null),
    pemReady,
    pemDiagnostics,
    message: ok
      ? "Google and myPOS environment variables are loaded."
      : (missing.length === 0
        ? "myPOS PEM values are present but not parseable."
        : `Missing environment variables: ${missing.join(", ")}.`)
  });
}
