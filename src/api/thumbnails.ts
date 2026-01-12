import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { cfg, type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const MAX_UPLOAD_SIZE = 10 << 20;

const formatThumbnailUrl = (videoId: string) => {
  return `http://localhost:${cfg.port}/api/thumbnails/${videoId}`
}

const formatBase64Url = (mediaType: string,data: string) => {
  return `data:${mediaType};base64,${data}`
}

const extractMediaType = (dataUrl: string): string | null => {
  const match = dataUrl.match(/^data:([^;]+);base64,/)
  return match ? match[1] : null
}

export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }

  const thumbnail = video.thumbnailURL;
  if (!thumbnail) {
    throw new NotFoundError("Thumbnail not found");
  }

  return new Response(thumbnail, {
    headers: {
      "Content-Type": thumbnail.mediaType,
      "Cache-Control": "no-store",
    },
  });
}

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();
  const file = formData.get("thumbnail");
  
  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  if(file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 10 mb")
  }

  const arrBuff = await file.arrayBuffer();

  const thumbnail: Thumbnail = {
    data: arrBuff,
    mediaType: file.type
  }
  const video = getVideo(cfg.db,videoId);

  if(!video || video.userID !== userID) {
    throw new UserForbiddenError("video not found for this user")
  }

  const base64 = Buffer.from(arrBuff).toBase64();

  const newVideo = {
    ...video,
    thumbnailURL : formatBase64Url(thumbnail.mediaType,base64)
  }

  updateVideo(cfg.db,newVideo)

  return respondWithJSON(200, [newVideo]);
}
