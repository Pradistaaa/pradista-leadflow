import { createClient } from "@supabase/supabase-js";

export async function POST({ request }) {
  try {
    const body = await request.json();

    const keyword = String(body.keyword || "").trim();
    const location = String(body.location || "").trim();
    const limit = Number(body.limit || 20);

    if (!keyword) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Keyword wajib diisi."
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

const serviceRoleKey =
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY;

let token =
  import.meta.env.APIFY_API_TOKEN;

if (supabaseUrl && serviceRoleKey) {
  const settingsClient = createClient(
    supabaseUrl,
    serviceRoleKey
  );

  const { data: setting } =
    await settingsClient
      .from("app_settings")
      .select("setting_value")
      .eq(
        "setting_key",
        "apify_api_token"
      )
      .maybeSingle();

  if (setting?.setting_value) {
    token = setting.setting_value;
  }
}

    if (!token) {
      console.error("APIFY_API_TOKEN tidak ditemukan.");

      return new Response(
        JSON.stringify({
          success: false,
          message: "APIFY_API_TOKEN belum diatur."
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    const input = {
      searchStringsArray: [keyword],
      locationQuery: location,
      maxCrawledPlacesPerSearch: Math.min(limit, 100),
      language: "id",
      maximumLeadsEnrichmentRecords: 0
    };

    console.log(
      "SEARCH:",
      keyword,
      "| LOCATION:",
      location
    );

    const response = await fetch(
      "https://api.apify.com/v2/acts/compass~crawler-google-places/run-sync-get-dataset-items",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },

        body: JSON.stringify(input)
      }
    );

    const rawResponse = await response.text();

    let data = [];

    try {
      data = rawResponse
        ? JSON.parse(rawResponse)
        : [];
    } catch {
      console.error(
        "Response Apify bukan JSON:",
        rawResponse.slice(0, 1000)
      );

      return new Response(
        JSON.stringify({
          success: false,
          message: "Response dari Apify bukan JSON valid.",
          rawResponse: rawResponse.slice(0, 1000)
        }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    if (!response.ok) {
      console.error(
        "APIFY ERROR:",
        response.status,
        data
      );

      return new Response(
        JSON.stringify({
          success: false,
          message:
            data?.error?.message ||
            data?.message ||
            "Apify gagal menjalankan pencarian.",
          details: data
        }),
        {
          status: response.status,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }

    console.log(
      "APIFY BERHASIL:",
      Array.isArray(data) ? data.length : 0,
      "hasil"
    );

    /*
     * ============================================
     * WEBSITE VERIFICATION
     * ============================================
     */

    function normalizeWebsite(value) {
      if (!value) return "";

      let url = String(value).trim();

      if (!url) return "";

      /*
       * Jangan pernah menganggap URL Google Maps
       * sebagai website bisnis.
       */
      const lower = url.toLowerCase();

      if (
        lower.includes("google.com/maps") ||
        lower.includes("maps.google.com") ||
        lower.includes("goo.gl/maps") ||
        lower.includes("maps.app.goo.gl")
      ) {
        return "";
      }

      /*
       * Hanya terima http / https.
       */
      if (
        !lower.startsWith("http://") &&
        !lower.startsWith("https://")
      ) {
        url = `https://${url}`;
      }

      try {
        const parsed = new URL(url);

        if (
          parsed.protocol !== "http:" &&
          parsed.protocol !== "https:"
        ) {
          return "";
        }

        return parsed.href;
      } catch {
        return "";
      }
    }

    async function verifyWebsite(url) {
      if (!url) {
        return {
          status: "not_found",
          label: "Website tidak ditemukan",
          website: ""
        };
      }

      const controller = new AbortController();

      const timeout = setTimeout(() => {
        controller.abort();
      }, 6000);

      try {
        /*
         * Coba HEAD terlebih dahulu.
         */
        let response;

        try {
          response = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            signal: controller.signal,
            headers: {
              "User-Agent":
                "Mozilla/5.0 LeadFlow Website Checker"
            }
          });
        } catch {
          /*
           * Beberapa website menolak HEAD.
           * Coba GET sebagai fallback.
           */
          response = await fetch(url, {
            method: "GET",
            redirect: "follow",
            signal: controller.signal,
            headers: {
              "User-Agent":
                "Mozilla/5.0 LeadFlow Website Checker"
            }
          });
        }

        clearTimeout(timeout);

        /*
         * Website benar-benar merespons.
         *
         * 2xx / 3xx = tersedia.
         *
         * 403 / 401 tetap kita anggap unverified,
         * karena website bisa saja ada tetapi
         * memblokir bot.
         */
        if (
          response.status >= 200 &&
          response.status < 400
        ) {
          return {
            status: "verified",
            label: "Website tersedia",
            website: url
          };
        }

        return {
          status: "unverified",
          label: "Website tidak dapat diverifikasi",
          website: url
        };

      } catch (error) {
        clearTimeout(timeout);

        console.log(
          "Website verification gagal:",
          url,
          error?.message
        );

        return {
          status: "unverified",
          label: "Website tidak dapat diverifikasi",
          website: url
        };
      }
    }

    /*
     * ============================================
     * PROSES SEMUA HASIL APIFY
     * ============================================
     */

    const results = Array.isArray(data)
      ? data
      : [];

    /*
     * Kita proses maksimal 5 website secara
     * bersamaan supaya endpoint tidak terlalu berat.
     */

    const processedResults = [];

    for (
      let i = 0;
      i < results.length;
      i += 5
    ) {
      const batch = results.slice(i, i + 5);

      const processedBatch =
        await Promise.all(
          batch.map(async (result) => {

            /*
             * PENTING:
             *
             * HANYA result.website yang dianggap
             * sebagai website bisnis.
             *
             * result.url TIDAK digunakan.
             */
            const rawWebsite =
              result?.website || "";

            const website =
              normalizeWebsite(rawWebsite);

            const verification =
              await verifyWebsite(website);

            return {
              ...result,

              website:
                verification.website,

              websiteStatus:
                verification.status,

              websiteLabel:
                verification.label
            };
          })
        );

      processedResults.push(
        ...processedBatch
      );
    }

    console.log(
      "WEBSITE CHECK SELESAI:",
      processedResults.map((item) => ({
        name: item.title || item.name,
        website: item.website,
        status: item.websiteStatus
      }))
    );

    return new Response(
      JSON.stringify({
        success: true,
        results: processedResults
      }),
      {
        status: 200,

        headers: {
          "Content-Type":
            "application/json"
        }
      }
    );

  } catch (error) {

    console.error(
      "SEARCH PROSPECT ERROR:",
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
          "Content-Type":
            "application/json"
        }
      }
    );
  }
}