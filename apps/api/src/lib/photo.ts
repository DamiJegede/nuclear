/** SQL fragment: the photo path for a tag model joined as m with its upload as p (an upload wins over an external URL). */
export const PHOTO_SQL = `case when p.model_id is not null
  then '/v1/shop/models/' || m.id || '/photo?v=' || extract(epoch from p.updated_at)::bigint else m.photo end as photo`;
