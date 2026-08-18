import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("card checkout has one outer scroll surface and a persistent pay action", () => {
  const checkoutMarkup = source.match(
    /<div class="([^"]*)" id="mypos-embedded-checkout"><\/div>/
  );

  assert.ok(checkoutMarkup, "myPOS checkout container should exist");
  assert.match(checkoutMarkup[1], /overflow-visible/);
  assert.doesNotMatch(checkoutMarkup[1], /overflow-y-auto/);
  assert.match(source, /#mypos-embedded-checkout \{[\s\S]*?overflow: visible;/);
  assert.doesNotMatch(
    source,
    /#mypos-embedded-checkout \{[\s\S]{0,240}?max-height:/
  );
  assert.match(source, /id="payment-card-submit-bar"/);
  assert.match(source, /id="payment-card-submit"/);
});

test("myPOS deferred form uses the external button without changing payment parameters", () => {
  assert.match(source, /sdk\.createPaymentForm\(/);
  assert.match(source, /currentMyposPaymentForm\.processPayment\(\)/);
  assert.doesNotMatch(source, /await sdk\.createPayment\(/);
  assert.match(source, /frame\.setAttribute\('scrolling', 'no'\)/);
  assert.match(source, /checkoutData\.paymentParams/);
});
