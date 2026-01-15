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

  if(file.size > MAX_VIDEO_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 1 gb")
  }

  if(file.type !== "video/mp4") {
    throw new BadRequestError("Invalid file type")
  }

  const video = getVideo(cfg.db,videoId);

  if (!video || video.userID !== userID) {
    throw new UserForbiddenError("video not found for this user")
  }

  const arrBuff = await file.arrayBuffer();
  const uuid = randomBytes(32).toHex();
  const s3Key = `videos/${uuid}.mp4`;
  const filePath = generateVideoFilePath(uuid);

  try {
    await Bun.write(filePath,arrBuff);

    await cfg.s3client.file(s3Key,{
      type : "video/mp4"
    }).write(Bun.file(filePath));
  } 
  catch(err) {
    throw err
  }
  finally {
    await unlink(filePath);
  }

  const newVideo : Video = {
    ...video,
    updatedAt: new Date(),
    videoURL: formatAwsUrlForS3(s3Key)
  }

  updateVideo(cfg.db, newVideo)

  return respondWithJSON(200, null);
}
