/**
 * Standalone Cloudflare Worker: worker.js
 * Handles payment routing for /api/pay/stripe and /api/pay/toyyibpay
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Health check endpoint
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "ok", service: "Langkawi Tour Payment API" }), {
        headers: CORS_HEADERS
      });
    }

    // Stripe checkout session endpoint
    if (url.pathname === "/api/pay/stripe" && request.method === "POST") {
      return handleStripe(request, env);
    }

    // ToyyibPay bill creation endpoint
    if (url.pathname === "/api/pay/toyyibpay" && request.method === "POST") {
      return handleToyyibPay(request, env);
    }

    return new Response(JSON.stringify({ error: "Endpoint not found" }), {
      status: 404,
      headers: CORS_HEADERS
    });
  }
};

/**
 * Handle Stripe Checkout Session Creation
 */
async function handleStripe(request, env) {
  try {
    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return new Response(
        JSON.stringify({ error: "STRIPE_SECRET_KEY is not configured in Cloudflare environment variables." }),
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
    params.append("payment_method_types[0]", "card");
    params.append("payment_method_types[1]", "fpx");

    let itemIndex = 0;
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
      params.append(`line_items[${itemIndex}][price_data][currency]`, "myr");
      params.append(`line_items[${itemIndex}][price_data][product_data][name]`, `Langkawi Tour Booking - ${order.ref}`);
      params.append(`line_items[${itemIndex}][price_data][unit_amount]`, Math.round(Number(order.total) * 100).toString());
      params.append(`line_items[${itemIndex}][quantity]`, "1");
      itemIndex++;
    }

    if (processingFeeCents > 0) {
      params.append(`line_items[${itemIndex}][price_data][currency]`, "myr");
      params.append(`line_items[${itemIndex}][price_data][product_data][name]`, "Payment Processing & Gateway Fee");
      params.append(`line_items[${itemIndex}][price_data][product_data][description]`, "Card & Online Banking transaction processing fee (3% + RM 1.00)");
      params.append(`line_items[${itemIndex}][price_data][unit_amount]`, processingFeeCents.toString());
      params.append(`line_items[${itemIndex}][quantity]`, "1");
    }

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
      return new Response(
        JSON.stringify({ error: session?.error?.message || "Failed to create Stripe Checkout session." }),
        { status: stripeRes.status || 500, headers: CORS_HEADERS }
      );
    }

    return new Response(
      JSON.stringify({ success: true, checkoutUrl: session.url, sessionId: session.id }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

/**
 * Handle ToyyibPay Bill Creation
 */
async function handleToyyibPay(request, env) {
  try {
    const secretKey = env.TOYYIBPAY_SECRET_KEY;
    const categoryCode = env.TOYYIBPAY_CATEGORY_CODE || "4zr2m3v5";
    const isSandbox = (env.TOYYIBPAY_ENV || "").toLowerCase() === "sandbox";

    if (!secretKey) {
      return new Response(
        JSON.stringify({ error: "TOYYIBPAY_SECRET_KEY is not configured in Cloudflare environment variables." }),
        { status: 500, headers: CORS_HEADERS }
      );
    }

    if (!categoryCode) {
      return new Response(
        JSON.stringify({ error: "TOYYIBPAY_CATEGORY_CODE is not configured. Please add Category Code from ToyyibPay dashboard." }),
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

    const toyyibHost = isSandbox ? "https://dev.toyyibpay.com" : "https://toyyibpay.com";
    const createBillUrl = `${toyyibHost}/index.php/api/createBill`;
    const amountInSen = Math.round(Number(order.total) * 100);

    let cleanPhone = (order.customer.phone || "").replace(/[^0-9]/g, "");
    if (cleanPhone.startsWith("60")) cleanPhone = "0" + cleanPhone.slice(2);
    if (!cleanPhone) cleanPhone = "0175895116";

    const params = new URLSearchParams();
    params.append("userSecretKey", secretKey.trim());
    params.append("categoryCode", categoryCode.trim());
    params.append("billName", `Tour Ref: ${order.ref}`.substring(0, 30));
    params.append("billDescription", `Langkawi Tour Booking ${order.ref} - ${order.customer.name}`.substring(0, 100));
    params.append("billPriceSetting", "1");
    params.append("billPayorInfo", "1");
    params.append("billAmount", amountInSen.toString());
    params.append("billReturnUrl", `${siteUrl}/?payment=toyyibpay_return&ref=${encodeURIComponent(order.ref)}`);
    params.append("billCallbackUrl", `${siteUrl}/api/pay/toyyibpay-callback`);
    params.append("billExternalReferenceNo", order.ref);
    params.append("billTo", (order.customer.name || "Customer").substring(0, 30));
    params.append("billEmail", order.customer.email);
    params.append("billPhone", cleanPhone);
    params.append("billSplitPayment", "0");
    params.append("billSplitPaymentArgs", "");
    params.append("billPaymentChannel", "0");
    params.append("billDisplayMerchant", "1");
    params.append("billContentEmail", `Thank you for booking with Langkawi Tour & Travel. Booking Ref: ${order.ref}. Travel Date: ${order.travelDate || 'As booked'}.`);
    // Customer bears the fee
    params.append("billChargeToCustomer", "1");

    const toyyibRes = await fetch(createBillUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });

    const responseText = await toyyibRes.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Invalid response from ToyyibPay API: " + responseText }),
        { status: 502, headers: CORS_HEADERS }
      );
    }

    let billCode = null;
    if (Array.isArray(data) && data.length > 0) {
      if (data[0].BillCode) billCode = data[0].BillCode;
      else if (data[0].msg) {
        return new Response(
          JSON.stringify({ error: `ToyyibPay Error: ${data[0].msg}` }),
          { status: 400, headers: CORS_HEADERS }
        );
      }
    } else if (data && data.BillCode) {
      billCode = data.BillCode;
    }

    if (!billCode) {
      return new Response(
        JSON.stringify({ error: "Failed to obtain ToyyibPay BillCode.", details: data }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    return new Response(
      JSON.stringify({ success: true, checkoutUrl: `${toyyibHost}/${billCode}`, billCode: billCode }),
      { status: 200, headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
