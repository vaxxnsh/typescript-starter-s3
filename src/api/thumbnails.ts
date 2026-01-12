import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo, type Video } from "../db/videos";
import { cfg, type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "path";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const MAX_UPLOAD_SIZE = 10 << 20;

const formatThumbnailUrl = (videoId: string,extension : string) => {
  return `http://localhost:${cfg.port}/assets/${videoId}.${extension}`
}

const formatBase64Url = (mediaType: string,data: string) => {
  return `data:${mediaType};base64,${data}`
}

const validThumbNailTypes = (mimeType : string) : boolean => {
  switch (mimeType) {
    case "image/jpeg": return true
    case "image/png" : return true
    default: return false
  }
}

const extractMediaType = (fileName: string) => {
  const splits = fileName.split(".")
  return splits[splits.length -1];
}

const formatFileName = (videoId : string,fileType : string) => {
  return path.join(cfg.assetsRoot,videoId.concat(".",fileType))
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
      "Content-Type": "image/png",
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

  if (!validThumbNailTypes(file.type)) {
    throw new BadRequestError("Invalid file type")
  }

  if(file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("File size exceeds 10 mb")
  }

  const arrBuff = await file.arrayBuffer();
  const video = getVideo(cfg.db,videoId);

  if(!video || video.userID !== userID) {
    throw new UserForbiddenError("video not found for this user")
  }

  const newVideo = {
    ...video,
    thumbnailURL : formatThumbnailUrl(videoId,extractMediaType(file.name))
  }

  console.log("filename: ",formatFileName(videoId,extractMediaType(file.name)))

  Bun.write(formatFileName(videoId,extractMediaType(file.name)),arrBuff)

  updateVideo(cfg.db,newVideo)

  return respondWithJSON(200, [newVideo]);
}
