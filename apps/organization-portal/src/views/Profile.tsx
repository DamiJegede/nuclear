import { useRef, useState } from "react";
import type { Account, Api } from "../api";
import { usePageTitle } from "../title";
import { Avatar } from "./Avatar";
import { PhotoCrop } from "./PhotoCrop";

/** The organization's name, email and picture. */
export function Profile({ api, account, onChanged }: { api: Api; account: Account; onChanged: () => void }) {
  usePageTitle("Profile");
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(f.type)) return setError("Choose a PNG, JPEG or WebP image.");
    if (f.size > 8 * 1024 * 1024) return setError("The image is over 8 MB.");
    setFile(f);
  }
  return (
    <section>
      <div className="head"><h1>Profile</h1></div>
      <div className="card">
        <h2>Organization</h2>
        <div className="profile-row">
          <button type="button" className="photo-btn" aria-label="Replace profile picture" onClick={() => input.current?.click()}>
            <Avatar name={account.name} photo={account.photo} />
            <span className="photo-hint" aria-hidden>{account.photo ? "Replace" : "Add Picture"}</span>
          </button>
          <input ref={input} type="file" className="sr-only" aria-label="Profile picture" accept="image/png,image/jpeg,image/webp" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
          <dl className="facts">
            <div><dt>Name</dt><dd>{account.name}</dd></div>
            <div><dt>Email</dt><dd>{account.email ?? "—"}</dd></div>
          </dl>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      {file && <PhotoCrop file={file} onClose={() => setFile(null)} onSave={async (jpeg) => { await api.uploadPhoto(jpeg); setFile(null); onChanged(); }} />}
    </section>
  );
}
