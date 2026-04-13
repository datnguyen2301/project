#!/usr/bin/env python3
"""
VisionGuard — Clip Generator
Mode 1 (JPEG frames): frame_*.jpg → MP4 + GIF
Mode 2 (Video input):  MP4/MKV → optimized MP4 + GIF

Usage:
    # From JPEG frames
    python generate_clip.py \
        --frames "/path/to/frames_dir" \
        --output-mp4 "/path/out.mp4" \
        --output-gif "/path/out.gif" \
        --fps 5

    # From existing video (RTSP recording)
    python generate_clip.py \
        --input-video "/path/input.mp4" \
        --output-mp4 "/path/out.mp4" \
        --output-gif "/path/out.gif"
"""

import argparse
import os
import sys
import subprocess
from pathlib import Path


def run_cmd(cmd, timeout=120):
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        shell=False,
    )
    return result


def make_mp4_from_frames(tmp_dir, output_mp4, fps=5, width=None, height=None):
    os.makedirs(os.path.dirname(output_mp4) or '.', exist_ok=True)

    out_dir = os.path.dirname(output_mp4) or '.'
    concat_list = os.path.join(out_dir, f'.concat_list_{os.getpid()}.txt')
    with open(concat_list, 'w', encoding='utf-8') as f:
        for i, frame_file in enumerate(sorted(os.listdir(tmp_dir))):
            if frame_file.startswith('frame_') and frame_file.endswith('.jpg'):
                abs_path = os.path.abspath(os.path.join(tmp_dir, frame_file))
                f.write(f"file '{abs_path}'\n")
                f.write(f"duration {1.0 / fps}\n")

    scale_filter = ''
    if width and height:
        scale_filter = f',scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2'
    elif width:
        scale_filter = f',scale={width}:-2'
    elif height:
        scale_filter = f',scale=-2:{height}'

    cmd = [
        'ffmpeg', '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', concat_list,
        '-vf', f"fps={fps}{scale_filter}".lstrip(','),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        output_mp4,
    ]

    result = run_cmd(cmd, timeout=120)
    try:
        os.remove(concat_list)
    except OSError:
        pass

    if result.returncode != 0:
        print(f"[generate_clip] MP4 stderr: {result.stderr[-500:]}", file=sys.stderr)
        raise RuntimeError(f"FFmpeg MP4 failed with code {result.returncode}")

    mp4_size = os.path.getsize(output_mp4)
    print(f"[generate_clip] MP4 created: {output_mp4} ({mp4_size} bytes)")
    return output_mp4


def optimize_video(input_video, output_mp4, max_duration=None):
    os.makedirs(os.path.dirname(output_mp4) or '.', exist_ok=True)

    cmd = [
        'ffmpeg', '-y',
        '-i', input_video,
    ]

    if max_duration:
        cmd.extend(['-t', str(max_duration)])

    cmd.extend([
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-an',
        output_mp4,
    ])

    result = run_cmd(cmd, timeout=180)
    if result.returncode != 0:
        print(f"[generate_clip] optimize stderr: {result.stderr[-500:]}", file=sys.stderr)
        # Fallback: try copy mode
        cmd_copy = [
            'ffmpeg', '-y',
            '-i', input_video,
        ]
        if max_duration:
            cmd_copy.extend(['-t', str(max_duration)])
        cmd_copy.extend([
            '-c', 'copy',
            '-movflags', '+faststart',
            output_mp4,
        ])
        result2 = run_cmd(cmd_copy, timeout=120)
        if result2.returncode != 0:
            print(f"[generate_clip] copy fallback stderr: {result2.stderr[-500:]}", file=sys.stderr)
            raise RuntimeError(f"FFmpeg optimize failed with code {result.returncode}")

    mp4_size = os.path.getsize(output_mp4)
    print(f"[generate_clip] Optimized MP4: {output_mp4} ({mp4_size} bytes)")
    return output_mp4


def make_gif(input_mp4, output_gif, fps=5, width=None, height=None):
    tmp_gif_raw = output_gif.replace('.gif', '_raw.gif')

    max_w = width or 640
    scale_filter = f'scale={max_w}:-1:flags=lanczos'

    cmd_palette = [
        'ffmpeg', '-y',
        '-i', input_mp4,
        '-vf', f"{scale_filter},fps={fps},palettegen=stats_mode=diff",
        tmp_gif_raw,
    ]
    result = run_cmd(cmd_palette, timeout=60)
    if result.returncode != 0:
        print(f"[generate_clip] palettegen stderr: {result.stderr[-500:]}", file=sys.stderr)
        raise RuntimeError(f"palettegen failed: code {result.returncode}")

    cmd_gif = [
        'ffmpeg', '-y',
        '-i', input_mp4,
        '-i', tmp_gif_raw,
        '-lavfi', f"{scale_filter},fps={fps}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5",
        output_gif,
    ]
    result = run_cmd(cmd_gif, timeout=60)
    try:
        os.remove(tmp_gif_raw)
    except OSError:
        pass

    if result.returncode != 0:
        print(f"[generate_clip] GIF stderr: {result.stderr[-500:]}", file=sys.stderr)
        raise RuntimeError(f"FFmpeg GIF failed with code {result.returncode}")

    gif_size = os.path.getsize(output_gif)
    print(f"[generate_clip] GIF created: {output_gif} ({gif_size} bytes)")
    return output_gif


def main():
    parser = argparse.ArgumentParser(description='Generate MP4 clip and GIF from JPEG frames or video')
    parser.add_argument('--frames', default=None, help='Directory containing frame_00000.jpg, frame_00001.jpg, ...')
    parser.add_argument('--input-video', default=None, help='Input video file (MP4/MKV from RTSP recording)')
    parser.add_argument('--output-mp4', required=True, help='Output MP4 file path')
    parser.add_argument('--output-gif', required=True, help='Output GIF file path')
    parser.add_argument('--fps', type=int, default=5, help='Output FPS (default: 5)')
    parser.add_argument('--width', type=int, default=None, help='Output width (optional)')
    parser.add_argument('--height', type=int, default=None, help='Output height (optional)')
    parser.add_argument('--max-duration', type=int, default=None, help='Max clip duration in seconds')

    args = parser.parse_args()

    if not args.frames and not args.input_video:
        print("[generate_clip] Error: must provide --frames or --input-video", file=sys.stderr)
        return 1

    if args.input_video:
        input_path = os.path.abspath(args.input_video)
        if not os.path.isfile(input_path):
            raise FileNotFoundError(f"Input video not found: {input_path}")

        file_size = os.path.getsize(input_path)
        print(f"[generate_clip] Processing video: {input_path} ({file_size} bytes)")

        optimize_video(input_path, args.output_mp4, max_duration=args.max_duration)

        make_gif(
            args.output_mp4,
            args.output_gif,
            fps=min(args.fps, 10),
            width=args.width or 640,
        )
    else:
        tmp_dir = os.path.abspath(args.frames)
        if not os.path.isdir(tmp_dir):
            raise FileNotFoundError(f"Frame directory not found: {tmp_dir}")

        frame_files = sorted([f for f in os.listdir(tmp_dir) if f.startswith('frame_') and f.endswith('.jpg')])
        if not frame_files:
            raise FileNotFoundError(f"No frame_*.jpg files found in {tmp_dir}")

        print(f"[generate_clip] Generating clip from {len(frame_files)} frames at {args.fps} fps")

        make_mp4_from_frames(
            tmp_dir,
            args.output_mp4,
            fps=args.fps,
            width=args.width,
            height=args.height,
        )

        make_gif(
            args.output_mp4,
            args.output_gif,
            fps=args.fps,
            width=args.width or 640,
        )

    print("[generate_clip] Done.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
