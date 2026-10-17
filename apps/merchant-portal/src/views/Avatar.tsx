/** A 128 x 128 photo (or 32 x 32 with `small`); initials when there is none (or it is not an image address). */
export function Avatar({ name, photo, small = false }: { name: string; photo: string | null; small?: boolean }) {
  const px = small ? 32 : 128;
  const isUrl = !!photo && /^(https?:)?\/\//.test(photo);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return isUrl
    ? <img className={small ? "avatar sm" : "avatar"} src={photo!} alt={`${name}'s photo`} width={px} height={px} />
    : <div className={small ? "avatar sm avatar-initials" : "avatar avatar-initials"} role="img" aria-label={`${name}, no photo`}>{initials || "?"}</div>;
}
