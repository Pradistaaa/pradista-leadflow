import { createClient } from "@supabase/supabase-js";

export async function POST({ request }) {
  try {
    const body = await request.json();
    const token = String(body.token || "").trim();

    if (!token) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Token Apify wajib diisi."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    const supabaseUrl =
      import.meta.env.PUBLIC_SUPABASE_URL;

    const publicKey =
      import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    const serviceRoleKey =
      import.meta.env.SUPABASE_SERVICE_ROLE_KEY;

    if (
      !supabaseUrl ||
      !publicKey ||
      !serviceRoleKey
    ) {
      return new Response(
        JSON.stringify({
          success: false,
          message:
            "Konfigurasi Supabase server belum tersedia."
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    // Cek login pengguna
    const authHeader =
      request.headers.get("authorization") || "";

    const accessToken =
      authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : "";

    if (!accessToken) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Anda harus login terlebih dahulu."
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    const authClient = createClient(
      supabaseUrl,
      publicKey,
      {
        global: {
          headers: {
            Authorization:
              `Bearer ${accessToken}`
          }
        }
      }
    );

    const {
      data: userData,
      error: authError
    } = await authClient.auth.getUser();

    if (authError || !userData?.user) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Sesi login tidak valid."
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    // Client khusus server untuk menyimpan token
    const supabase = createClient(
      supabaseUrl,
      serviceRoleKey
    );

    const { error } = await supabase
      .from("app_settings")
      .upsert(
        {
          setting_key: "apify_api_token",
          setting_value: token,
          updated_at: new Date().toISOString()
        },
        {
          onConflict: "setting_key"
        }
      );

    if (error) {
      console.error(
        "Gagal menyimpan Apify token:",
        error
      );

      return new Response(
        JSON.stringify({
          success: false,
          message: "Gagal menyimpan token."
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Apify token berhasil disimpan."
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );

  } catch (error) {
    console.error(
      "APIFY SETTINGS ERROR:",
      error
    );

    return new Response(
      JSON.stringify({
        success: false,
        message:
          error?.message ||
          "Terjadi kesalahan."
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
}