"use client";

import { useDropzone } from "react-dropzone";

type Props = {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
};

export default function UploadDropzone({ onFiles, disabled }: Props) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: onFiles,
    accept: {
      "image/jpeg": [],
      "image/png": [],
      "image/webp": [],
    },
    multiple: true,
    disabled,
  });

  return (
    <div
      {...getRootProps()}
      className={[
        "flex h-20 cursor-pointer flex-col items-center justify-center border-2 border-dashed m-2 rounded-lg text-xs transition-colors",
        isDragActive
          ? "border-blue-400 bg-blue-50 text-blue-600"
          : "border-zinc-200 bg-zinc-50 text-zinc-400 hover:border-zinc-300 hover:text-zinc-500",
        disabled ? "cursor-not-allowed opacity-50" : "",
      ].join(" ")}
    >
      <input {...getInputProps()} />
      <span className="text-center leading-relaxed">
        {isDragActive ? "ドロップして追加" : "画像をドロップ or クリックして選択"}
      </span>
    </div>
  );
}
