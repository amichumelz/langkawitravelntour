/**
 * Cloudflare Pages Function: /api/pay/stripe
 * Handles Stripe Checkout Session creation with customer-paid processing fee
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
};

export async function onRequestOptions() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const stripeKey = env.STRIPE_SECRET_KEY;

    if (!stripeKey) {
      return new Response(
        JSON.stringify({
          error: "STRIPE_SECRET_KEY is not configured in Cloudflare environment variables."
        }),
        { status: 500, headers: CORS_HEADERS }
      );
    }

    const order = await request.json();

    if (!order || !order.total || !order.customer || !order.customer.email) {
      return new Response(
        JSON.stringify({ error: "Invalid order payload. Missing customer details or total." }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const reqUrl = new URL(request.url);
    const siteUrl = (env.SITE_URL || reqUrl.origin).replace(/\/$/, "");

    // Customer bears the Stripe processing fee: 3% + RM 1.00
    const processingFeeCents = Math.round((Number(order.total) * 0.03 + 1.00) * 100);

    // Prepare URL-encoded params for Stripe API
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", `${siteUrl}/?payment=success&ref=${encodeURIComponent(order.ref)}&gateway=stripe&session_id={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${siteUrl}/?payment=cancel&ref=${encodeURIComponent(order.ref)}`);
    params.append("customer_email", order.customer.email);
    params.append("client_reference_id", order.ref);
    params.append("metadata[order_ref]", order.ref);
    params.append("metadata[customer_name]", order.customer.name || "");
    params.append("metadata[customer_phone]", order.customer.phone || "");
    params.append("metadata[travel_date]", order.travelDate || "");

    // Enable multiple payment methods (Card, Apple Pay, Google Pay, FPX)
    params.append("payment_method_types[0]", "card");
    params.append("payment_method_types[1]", "fpx");

    let itemIndex = 0;

    // 1. Tour items
    if (Array.isArray(order.items) && order.items.length > 0) {
      for (const item of order.items) {
        const itemAmountCents = Math.round(Number(item.price || 0) * 100);
        if (itemAmountCents <= 0) continue;

        params.append(`line_items[${itemIndex}][price_data][currency]`, "myr");
        params.append(`line_items[${itemIndex}][price_data][product_data][name]`, item.title || "Tour Package");
        if (item.date || item.time) {
          params.append(`line_items[${itemIndex}][price_data][product_data][description]`, `Date: ${item.date || order.travelDate} · Time: ${item.time || 'Flexible'}`);
        }
        params.append(`line_items[${itemIndex}][price_data][unit_amount]`, itemAmountCents.toString());
        params.append(`line_items[${itemIndex}][quantity]`, (item.qty || 1).toString());
        itemIndex++;
      }
    } else {
      // Fallback single line item if items array is empty
      params.append(`line_items[${itemIndex}][price_data][currency]`, "myr");
      params.append(`line_items[${itemIndex}][price_data][product_data][name]`, `Langkawi Tour Booking - ${order.ref}`);
      params.append(`line_items[${itemIndex}][price_data][unit_amount]`, Math.round(Number(order.total) * 100).toString());
      params.append(`line_items[${itemIndex}][quantity]`, "1");
      itemIndex++;
    }

    // 2. Gateway Processing Fee line item (Customer bears the fee)
    if (processingFeeCents > 0) {
      params.append(`line_items[${itemIndex}][price_data][currency]`, "myr");
      params.append(`line_items[${itemIndex}][price_data][product_data][name]`, "Payment Processing & Gateway Fee");
      params.append(`line_items[${itemIndex}][price_data][product_data][description]`, "Card & Online Banking transaction processing fee (3% + RM 1.00)");
      params.append(`line_items[${itemIndex}][price_data][unit_amount]`, processingFeeCents.toString());
      params.append(`line_items[${itemIndex}][quantity]`, "1");
    }

    // Call Stripe Checkout Sessions API
    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: params.toString()
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok || !session.url) {
      console.error("Stripe API Error:", session);
      return new Response(
        JSON.stringify({
          error: session?.error?.message || "Failed to create Stripe Checkout session."
        }),
        { status: stripeRes.status || 500, headers: CORS_HEADERS }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        checkoutUrl: session.url,
        sessionId: session.id
      }),
      { status: 200, headers: CORS_HEADERS }
    );

  } catch (err) {
    console.error("Stripe Handler Exception:", err);
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
