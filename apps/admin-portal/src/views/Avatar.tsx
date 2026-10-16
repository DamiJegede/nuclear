/** A 96 x 96 photo; initials when there is none (or it is not an image address). */
export function Avatar({ name, photo }: { name: string; photo: string | null }) {
  const isUrl = !!photo && /^(https?:)?\/\//.test(photo);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return isUrl
    ? <img className="avatar" src={photo!} alt={`${name}'s photo`} width={96} height={96} />
    : <div className="avatar avatar-initials" role="img" aria-label={`${name}, no photo`}>{initials || "?"}</div>;
}
