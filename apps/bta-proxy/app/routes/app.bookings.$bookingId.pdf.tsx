import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "~/shopify.server";
import { BookingDetailError, getBookingDetailData } from "~/domains/bookings/bookingDetailService";
import { buildBookingPdf } from "~/domains/bookings/bookingPdf";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const auth = await authenticate.admin(request);

  try {
    const detail = await getBookingDetailData({
      shop: auth.session.shop,
      admin: auth.admin,
      bookingId: params.bookingId,
    });

    const pdfBytes = await buildBookingPdf(detail);
    const filename = `booking-${detail.booking.travelDate}-${detail.booking.productId}.pdf`;
    const encodedFilename = encodeURIComponent(filename);
    const contentDisposition = `attachment; filename="${filename}"; filename*=UTF-8''${encodedFilename}`;

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": contentDisposition,
        "Content-Length": String(pdfBytes.length),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(
      JSON.stringify({
        message: "PDF generation failed",
        bookingId: params.bookingId || null,
        shop: auth.session.shop,
        error: errorMessage,
      }),
    );
    if (error instanceof BookingDetailError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response("PDF 생성 실패", { status: 500 });
  }
};
