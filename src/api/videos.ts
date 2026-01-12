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
