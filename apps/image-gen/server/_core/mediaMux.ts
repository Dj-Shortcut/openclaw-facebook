import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function muxMp4WithMp3(
  video: Uint8Array,
  audio: Uint8Array,
  options: { signal?: AbortSignal } = {}
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "leaderbot-media-"));
  const videoPath = join(dir, "video.mp4");
  const audioPath = join(dir, "voice.mp3");
  const outputPath = join(dir, "output.mp4");
  try {
    await writeFile(videoPath, video);
    await writeFile(audioPath, audio);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "ffmpeg",
        [
          "-y",
          "-i",
          videoPath,
          "-i",
          audioPath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-shortest",
          outputPath,
        ],
        {
          stdio: "ignore",
          signal: options.signal,
        }
      );
      child.once("error", reject);
      child.once("exit", code =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))
      );
    });
    return new Uint8Array(await readFile(outputPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
