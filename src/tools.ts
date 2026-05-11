import { eq } from "drizzle-orm";
import {
  db,
  devices,
  faceEmbeddings,
  members,
  voiceProfiles,
  wakeWordSamples,
} from "./db.js";

export async function executeLocalTool(
  name: string,
  arguments_: Record<string, unknown>,
  context: { userId: string }
) {
  switch (name) {
    case "smart_home":
      return runSmartHome(arguments_);
    case "spotify":
      return runSpotify(arguments_);
    case "device_command":
      return runDeviceCommand(arguments_, context.userId);
    case "members_list":
    case "list_household_members":
      return listMembers(context.userId);
    case "stereo_pair":
      return registerStereoPair(arguments_);
    default:
      throw new Error(`Unsupported tool: ${name}`);
  }
}

export async function listMembers(userId: string) {
  const rows = db.select().from(members).where(eq(members.userId, userId)).all();

  return rows.map((member) => {
    const samples = db
      .select()
      .from(wakeWordSamples)
      .where(eq(wakeWordSamples.memberId, member.id))
      .all();
    const voiceProfile =
      db.select().from(voiceProfiles).where(eq(voiceProfiles.memberId, member.id)).get() ??
      null;
    const faceEmbedding =
      db.select().from(faceEmbeddings).where(eq(faceEmbeddings.memberId, member.id)).get() ??
      null;

    return {
      id: member.id,
      name: member.name,
      relationship: member.relationship,
      slug: member.slug,
      email: member.email,
      enrollment_state: parseJson(member.enrollmentState, {}),
      wake_word_samples: samples.map((sample) => ({
        id: sample.id,
        word: sample.word,
        prefix: sample.prefix,
        filename: sample.filename,
        content_type: sample.contentType,
        duration_ms: sample.durationMs,
        sample_rate: sample.sampleRate,
        source: sample.source,
        created_at: sample.createdAt.toISOString(),
      })),
      voice_profile: voiceProfile
        ? {
            id: voiceProfile.id,
            method: voiceProfile.method,
            source: voiceProfile.source,
            filename: voiceProfile.filename,
            content_type: voiceProfile.contentType,
            updated_at: voiceProfile.updatedAt.toISOString(),
          }
        : null,
      face_embedding: faceEmbedding
        ? {
            id: faceEmbedding.id,
            model: faceEmbedding.model,
            source: faceEmbedding.source,
            filename: faceEmbedding.filename,
            content_type: faceEmbedding.contentType,
            updated_at: faceEmbedding.updatedAt.toISOString(),
          }
        : null,
    };
  });
}

async function runSmartHome(arguments_: Record<string, unknown>) {
  const haUrl = process.env.HOME_ASSISTANT_URL;
  const token = process.env.HOME_ASSISTANT_TOKEN;
  if (!haUrl || !token) {
    return { ok: false, error: "home_assistant_not_configured" };
  }

  const action = String(arguments_.action ?? "");
  const entityId = String(arguments_.entity_id ?? "");
  const payload =
    typeof arguments_.payload === "object" && arguments_.payload ? arguments_.payload : {};

  let domain = "homeassistant";
  let service = action;
  if (action === "scene") {
    domain = "scene";
    service = "turn_on";
  } else if (action.includes(".")) {
    [domain, service] = action.split(".", 2);
  }

  const response = await fetch(`${haUrl}/api/services/${domain}/${service}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ...(entityId ? { entity_id: entityId } : {}),
      ...(payload as Record<string, unknown>),
    }),
  });

  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    service: `${domain}.${service}`,
    body: text ? tryJson(text) : null,
  };
}

// Spotify Web API control. Configure on the host with:
//   SPOTIFY_CLIENT_ID=...
//   SPOTIFY_CLIENT_SECRET=...
//   SPOTIFY_REFRESH_TOKEN=...   (obtained via the OAuth Authorization Code flow once)
//   SPOTIFY_DEVICE_ID=...       (optional — Spotify Connect device to target;
//                               defaults to whichever device is "active" on the
//                               account, which is what the iPhone/desktop client
//                               just used)
//
// Supported `action` values mirror the cloud SpotifyProcessor:
//   play, pause, next, previous, volume, search_and_play
// `query` is used by search_and_play; `volume` (0-100) by volume.

interface SpotifyToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: SpotifyToken | null = null;

async function fetchSpotifyToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("spotify_not_configured");
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`spotify_token_refresh_failed status=${res.status} body=${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("spotify_token_refresh_no_access_token");
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

async function spotifyApi(
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const token = await fetchSpotifyToken();
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const deviceId = process.env.SPOTIFY_DEVICE_ID?.trim();
  // Spotify Connect supports an optional `device_id` query param on most
  // playback endpoints; passing it pins the action to that device.
  const url = deviceId && (path.startsWith("/me/player/play") || path.startsWith("/me/player/pause") || path.startsWith("/me/player/next") || path.startsWith("/me/player/previous") || path.startsWith("/me/player/volume"))
    ? `https://api.spotify.com/v1${path}${path.includes("?") ? "&" : "?"}device_id=${encodeURIComponent(deviceId)}`
    : `https://api.spotify.com/v1${path}`;
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
  return { status: res.status, body: parsed };
}

async function runSpotify(arguments_: Record<string, unknown>) {
  const action = String(arguments_.action ?? "").trim().toLowerCase();
  try {
    switch (action) {
      case "play":
      case "resume": {
        const r = await spotifyApi("PUT", "/me/player/play");
        return { ok: r.status >= 200 && r.status < 300, action: "play", status: r.status };
      }
      case "pause": {
        const r = await spotifyApi("PUT", "/me/player/pause");
        return { ok: r.status >= 200 && r.status < 300, action: "pause", status: r.status };
      }
      case "next":
      case "skip": {
        const r = await spotifyApi("POST", "/me/player/next");
        return { ok: r.status >= 200 && r.status < 300, action: "next", status: r.status };
      }
      case "previous":
      case "back": {
        const r = await spotifyApi("POST", "/me/player/previous");
        return { ok: r.status >= 200 && r.status < 300, action: "previous", status: r.status };
      }
      case "volume": {
        const level = Math.max(0, Math.min(Number(arguments_.volume ?? arguments_.level ?? 50), 100));
        const r = await spotifyApi("PUT", `/me/player/volume?volume_percent=${Math.round(level)}`);
        return { ok: r.status >= 200 && r.status < 300, action: "volume", level, status: r.status };
      }
      case "search_and_play":
      case "play_track": {
        const query = String(arguments_.query ?? "").trim();
        if (!query) return { ok: false, error: "query_required" };
        const search = await spotifyApi("GET", `/search?type=track&limit=1&q=${encodeURIComponent(query)}`);
        const track = (search.body as { tracks?: { items?: Array<{ uri?: string; name?: string; artists?: Array<{ name?: string }> }> } })?.tracks?.items?.[0];
        if (!track?.uri) return { ok: false, error: "no_track_found", query };
        const play = await spotifyApi("PUT", "/me/player/play", { uris: [track.uri] });
        return {
          ok: play.status >= 200 && play.status < 300,
          action: "play_track",
          track: { uri: track.uri, name: track.name, artists: (track.artists ?? []).map((a) => a.name).filter(Boolean) },
          status: play.status,
        };
      }
      default:
        return { ok: false, error: "unknown_action", action };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

async function runDeviceCommand(arguments_: Record<string, unknown>, userId: string) {
  const requestedId = arguments_.device_id ? String(arguments_.device_id) : null;
  const command = String(arguments_.command ?? "");
  const payload =
    typeof arguments_.payload === "object" && arguments_.payload ? arguments_.payload : {};

  const device =
    (requestedId
      ? db.select().from(devices).where(eq(devices.id, requestedId)).get()
      : db.select().from(devices).where(eq(devices.userId, userId)).all().at(-1)) ?? null;

  return {
    ok: true,
    device_id: device?.id ?? requestedId,
    command,
    payload,
    queued: true,
    note: "Device command queue is not persisted yet in local-server; this is an accepted stub.",
  };
}

async function registerStereoPair(arguments_: Record<string, unknown>) {
  return {
    ok: true,
    master_id: arguments_.master_id ?? null,
    slave_id: arguments_.slave_id ?? null,
    note: "Stereo pairing registration accepted.",
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  try {
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function tryJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
