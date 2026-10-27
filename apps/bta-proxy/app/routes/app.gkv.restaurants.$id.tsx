import {
  RestaurantEditorPage,
} from "~/lib/gkv/adminRestaurantEditorRoute";
import {
  createRestaurantEditorAction,
  createRestaurantEditorLoader,
} from "~/lib/gkv/adminRestaurantEditorRoute.server";

export const loader = createRestaurantEditorLoader("edit");
export const action = createRestaurantEditorAction("edit");

export default function GkvRestaurantEditPage() {
  return <RestaurantEditorPage />;
}
