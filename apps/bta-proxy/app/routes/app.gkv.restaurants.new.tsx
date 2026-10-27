import {
  RestaurantEditorPage,
} from "~/lib/gkv/adminRestaurantEditorRoute";
import {
  createRestaurantEditorAction,
  createRestaurantEditorLoader,
} from "~/lib/gkv/adminRestaurantEditorRoute.server";

export const loader = createRestaurantEditorLoader("new");
export const action = createRestaurantEditorAction("new");

export default function GkvRestaurantNewPage() {
  return <RestaurantEditorPage />;
}
