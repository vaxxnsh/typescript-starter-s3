import { respondWithJSON } from "./json";

import { cfg, type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { randomBytes } from "crypto";
import { unlink } from "fs/promises";

const MAX_VIDEO_UPLOAD_SIZE = 1 << 30;

const generateVideoFilePath = (uuid : string) => {
  return `./${uuid}.mp4`
}

const formatAwsUrlForS3 = (s3Key : string) => {
  return `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Key}`
}

async function getVideoAspectRatio(filePath: string): Promise<"landscape" | "portrait" | "other"> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const stdoutText = await new Response(proc.stdout).text();
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe failed: ${stderrText}`);
  }

  const parsed = JSON.parse(stdoutText);
  const stream = parsed.streams?.[0];

  if (!stream?.width || !stream?.height) {
    throw new Error("Unable to determine video dimensions");
  }

  const { width, height } = stream;
  const ratio = width / height;

  const LANDSCAPE = 16 / 9;
  const PORTRAIT = 9 / 16;
  const TOLERANCE = 0.05;

  if (Math.abs(ratio - LANDSCAPE) < TOLERANCE) {
    return "landscape";
  }

  if (Math.abs(ratio - PORTRAIT) < TOLERANCE) {
    return "portrait";
  }

  return "other";
}

async function processVideoForFastStart(inputFilePath: string): Promise<string> {
  const outputPath = `${inputFilePath}.processed.mp4`;

  const proc = Bun.spawn([
    "ffmpeg",
    "-i",
    inputFilePath,
    "-movflags",
    "faststart",
    "-map_metadata",
    "0",
    "-codec",
    "copy",
    "-f",
    "mp4",
    outputPath,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    console.error("FFmpeg failed:", stderr);
    throw new Error(`FFmpeg failed with exit code ${exitCode}`);
  }

  return outputPath;
}


export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  const formData = await req.formData();
  const file = formData.get("video");

  console.log("uploading video with videoId", videoId, "by user", userID);

  if (!(file instanceof File)) {
    throw new BadRequestError("Video file missing");
  }

  if (file.size > MAX_VIDEO_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 1 gb");
  }

  if (file.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type");
  }

  const video = getVideo(cfg.db, videoId);

  if (!video || video.userID !== userID) {
    throw new UserForbiddenError("video not found for this user");
  }

  const arrBuff = await file.arrayBuffer();
  const uuid = randomBytes(32).toHex();
  const filePath = generateVideoFilePath(uuid);

  let s3Key: string;

  try {
    await Bun.write(filePath, arrBuff);

    const aspectRatio = await getVideoAspectRatio(filePath);

    const processedFilePath = await processVideoForFastStart(filePath);

    s3Key = `videos/${aspectRatio}/${uuid}.mp4`;

    await cfg.s3client
      .file(s3Key, { type: "video/mp4" })
      .write(Bun.file(processedFilePath));

    await unlink(processedFilePath);
  } catch (err) {
    throw err;
  } finally {
    await unlink(filePath).catch(() => {});
  }

  const newVideo: Video = {
    ...video,
    updatedAt: new Date(),
    videoURL: formatAwsUrlForS3(s3Key),
  };

  updateVideo(cfg.db, newVideo);

  return respondWithJSON(200, null);
}


