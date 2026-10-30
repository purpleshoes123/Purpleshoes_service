import { RestaurantEditorPage } from "~/domains/guide-viewer/adminRestaurantEditorRoute";
import {
  createRestaurantEditorAction,
  createRestaurantEditorLoader,
} from "~/domains/guide-viewer/adminRestaurantEditorRoute.server.ts";

export const loader = createRestaurantEditorLoader("new");
export const action = createRestaurantEditorAction("new");

export default function GkvRestaurantNewPage() {
  return <RestaurantEditorPage />;
}
