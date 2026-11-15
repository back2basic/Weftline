export async function parseAppwriteResponse(response) {
  if (response.status === 204) return {ok:response.ok, data:null};
  return {ok:response.ok, data:await response.json()};
}
