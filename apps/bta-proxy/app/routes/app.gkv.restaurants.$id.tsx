import { RestaurantEditorPage } from "~/domains/guide-viewer/adminRestaurantEditorRoute";
import {
  createRestaurantEditorAction,
  createRestaurantEditorLoader,
} from "~/domains/guide-viewer/adminRestaurantEditorRoute.server.ts";

export const loader = createRestaurantEditorLoader("edit");
export const action = createRestaurantEditorAction("edit");

export default function GkvRestaurantEditPage() {
  return <RestaurantEditorPage />;
}
