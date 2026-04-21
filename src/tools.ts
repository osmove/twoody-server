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

async function runSpotify(arguments_: Record<string, unknown>) {
  return {
    ok: true,
    provider: "local-server-stub",
    action: arguments_.action ?? null,
    query: arguments_.query ?? null,
    volume: arguments_.volume ?? null,
    note: "Spotify transport is not wired yet in local-server; command accepted for future routing.",
  };
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
